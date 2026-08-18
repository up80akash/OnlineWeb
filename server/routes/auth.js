const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { JWT_SECRET } = require("../middleware/auth");
const otpLib = require("../lib/otp");
const { sendOtpEmail } = require("../lib/mailer");
const { ipRateLimitMiddleware, checkLimit } = require("../lib/rateLimit");
const referral = require("../lib/referral");

const router = express.Router();
const PHONE_REGEX = /^[6-9]\d{9}$/;
const RESET_TOKEN_TTL = `${otpLib.OTP_TTL_MINUTES}m`;

router.post("/login", (req, res) => {
  const { phone, password } = req.body || {};

  if (!PHONE_REGEX.test(String(phone || "")) || !password) {
    return res.status(400).json({ error: "Enter a valid 10-digit mobile number and password." });
  }

  const user = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid phone number or password." });
  }
  if (user.status === "locked") {
    return res.status(403).json({ error: "This account has been locked. Contact the admin." });
  }

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h" });

  res.json({
    token,
    role: user.role,
    name: user.name,
    phone: user.phone,
    walletBalance: user.wallet_balance,
  });
});

router.post("/register", ipRateLimitMiddleware({ max: 10, windowMs: 60 * 60 * 1000, keyPrefix: "register" }), async (req, res) => {
  const { name, phone, password } = req.body || {};
  const email = otpLib.normalizeEmail(req.body?.email);

  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ error: "Enter a valid name." });
  }
  if (!PHONE_REGEX.test(String(phone || ""))) {
    return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  if (!email || !otpLib.isValidEmail(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const existingPhone = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existingPhone) {
    return res.status(409).json({ error: "A user with this mobile number already exists." });
  }
  // Registration is an authenticated intent to claim this email as part of
  // creating an account, unlike the anonymous forgot-password lookup below
  // -- confirming "this email is taken" here is expected UX, not the kind
  // of account-enumeration leak section 8 of the brief is about.
  const existingEmail = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existingEmail) {
    return res.status(409).json({ error: "An account with this email address already exists." });
  }

  // A referral code is optional, but if one was typed in it must resolve to
  // a real account -- silently ignoring a typo would let a user think
  // they'd credited a friend when they hadn't.
  const referralCodeInput = req.body?.referralCode ? String(req.body.referralCode).trim() : "";
  let referrer = null;
  if (referralCodeInput) {
    referrer = referral.findReferrerByCode(referralCodeInput);
    if (!referrer) {
      return res.status(400).json({ error: "That referral code isn't valid." });
    }
  }

  const subadmin = db.findSubadminForNewUser();
  if (!subadmin) {
    return res.status(503).json({ error: "Registration is temporarily unavailable. Please try again later." });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare(
      "INSERT INTO users (role, name, phone, password_hash, status, wallet_balance, sub_admin_id, email) VALUES ('user', ?, ?, ?, 'active', 0, ?, ?)"
    )
    .run(String(name).trim(), phone, hash, subadmin.id, email);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h" });

  // referrer.id can never equal user.id here (user.id is a brand-new
  // autoincrement row that didn't exist when referrer was looked up), but
  // recordReferral() still guards against it defensively.
  if (referrer) {
    referral.recordReferral(user.id, referrer.id, referralCodeInput.toUpperCase());
  }
  const referralCode = referral.ensureReferralCode(user.id);

  // Best-effort -- registration must succeed even if the verification email
  // fails to send; the user can resend from their profile (see routes/
  // account.js). Not awaited-and-checked against the response on purpose.
  issueOtp(user.id, "email_verification", email)
    .then((otp) => sendOtpEmail({ to: email, name: user.name, otp, purpose: "email_verification" }))
    .catch((err) => console.error(`[register] Failed to send verification email: ${err.message}`));

  res.status(201).json({
    token,
    role: user.role,
    name: user.name,
    phone: user.phone,
    email: user.email,
    emailVerified: false,
    walletBalance: user.wallet_balance,
    referralCode,
  });
});

// ---- Shared OTP issuance (password reset + email verification) ----
// A fresh OTP for a given user+purpose immediately supersedes any earlier
// unconsumed one -- only the newest can ever verify. Returns the raw OTP
// (caller is responsible for emailing it and never logging/returning it
// elsewhere).
async function issueOtp(userId, purpose, targetEmail) {
  const otp = otpLib.generateOtp();
  const otpHash = otpLib.hashOtp(otp);
  const expiresAt = db.prepare(`SELECT datetime('now', '+${otpLib.OTP_TTL_MINUTES} minutes') AS t`).get().t;

  const issue = db.transaction(() => {
    db.prepare(
      "UPDATE otp_verifications SET consumed_at = datetime('now') WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL"
    ).run(userId, purpose);
    db.prepare(
      "INSERT INTO otp_verifications (user_id, purpose, target_email, otp_hash, expires_at) VALUES (?, ?, ?, ?, ?)"
    ).run(userId, purpose, targetEmail, otpHash, expiresAt);
  });
  issue();
  return otp;
}

// True if the given user+purpose can request another OTP right now (60s
// cooldown since their last request, plus a per-hour cap as a second layer).
function canRequestOtp(userId, purpose) {
  const last = db
    .prepare("SELECT created_at FROM otp_verifications WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1")
    .get(userId, purpose);
  if (last) {
    const secondsSince = db
      .prepare(`SELECT (julianday('now') - julianday(?)) * 86400 AS s`)
      .get(last.created_at).s;
    if (secondsSince < otpLib.RESEND_COOLDOWN_SECONDS) {
      return { ok: false, retryAfterSeconds: Math.ceil(otpLib.RESEND_COOLDOWN_SECONDS - secondsSince) };
    }
  }
  const hourAgo = db.prepare(`SELECT datetime('now', '-60 minutes') AS t`).get().t;
  const recentCount = db
    .prepare("SELECT COUNT(*) AS n FROM otp_verifications WHERE user_id = ? AND purpose = ? AND created_at >= ?")
    .get(userId, purpose, hourAgo);
  if (recentCount.n >= otpLib.MAX_REQUESTS_PER_HOUR) {
    return { ok: false, retryAfterSeconds: null };
  }
  return { ok: true };
}

// ---- Forgot password (email OTP) ----
// Requires a *verified* email -- an account with no email, or an unverified
// one, cannot use this flow (matches the brief: password recovery must go
// through a verified email, never phone/username alone). Works for any
// role (user/subadmin/admin) since they all share the users table.
const GENERIC_OTP_SENT = { ok: true, message: "If an account exists with this email, a password reset OTP has been sent." };

router.post(
  "/forgot-password",
  ipRateLimitMiddleware({ max: 20, windowMs: 60 * 60 * 1000, keyPrefix: "forgot-password" }),
  async (req, res) => {
    const email = otpLib.normalizeEmail(req.body?.email);
    if (!email || !otpLib.isValidEmail(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    const user = db.prepare("SELECT id, name FROM users WHERE email = ? AND email_verified = 1").get(email);
    if (!user) {
      // Identical response whether the email is unregistered, unverified,
      // or simply mistyped -- never reveals which case applies.
      return res.json(GENERIC_OTP_SENT);
    }

    const gate = canRequestOtp(user.id, "password_reset");
    if (!gate.ok) {
      return res
        .status(429)
        .json({ error: gate.retryAfterSeconds ? `Please wait ${gate.retryAfterSeconds}s before requesting another OTP.` : "Too many OTP requests. Please try again later." });
    }

    const otp = await issueOtp(user.id, "password_reset", email);
    await sendOtpEmail({ to: email, name: user.name, otp, purpose: "password_reset" }); // never included in the HTTP response
    res.json(GENERIC_OTP_SENT);
  }
);

router.post(
  "/verify-reset-otp",
  ipRateLimitMiddleware({ max: 30, windowMs: 60 * 60 * 1000, keyPrefix: "verify-reset-otp" }),
  (req, res) => {
    const email = otpLib.normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || "").trim();
    if (!email || !otp) {
      return res.status(400).json({ error: "Enter your email and the OTP you received." });
    }

    const user = db.prepare("SELECT id FROM users WHERE email = ? AND email_verified = 1").get(email);
    const genericError = { error: "Invalid or expired OTP. Request a new one." };
    if (!user) {
      return res.status(400).json(genericError);
    }

    // verified = 0 makes this OTP genuinely single-use: once it's produced a
    // reset token (below), the same code can never verify again, even before
    // that token goes on to consume the row via reset-password.
    const row = db
      .prepare(
        "SELECT * FROM otp_verifications WHERE user_id = ? AND purpose = 'password_reset' AND consumed_at IS NULL AND verified = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1"
      )
      .get(user.id);
    if (!row) {
      return res.status(400).json(genericError);
    }
    if (row.attempts >= otpLib.MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({ error: "Too many incorrect attempts. Request a new OTP." });
    }
    if (!otpLib.verifyOtp(otp, row.otp_hash)) {
      db.prepare("UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?").run(row.id);
      const attemptsLeft = otpLib.MAX_VERIFY_ATTEMPTS - (row.attempts + 1);
      return res.status(400).json({ error: attemptsLeft > 0 ? `Invalid OTP. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left.` : "Invalid OTP. Request a new one." });
    }

    db.prepare("UPDATE otp_verifications SET verified = 1 WHERE id = ?").run(row.id);

    // Short-lived, single-purpose token binding the next step to this exact
    // verified OTP row -- the client can't skip straight to reset-password
    // without having actually verified an OTP first.
    const resetToken = jwt.sign({ purpose: "password_reset", userId: user.id, resetId: row.id }, JWT_SECRET, {
      expiresIn: RESET_TOKEN_TTL,
    });
    res.json({ ok: true, resetToken });
  }
);

router.post("/reset-password", (req, res) => {
  const { resetToken, newPassword, confirmPassword } = req.body || {};

  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "Passwords do not match." });
  }

  const invalidSession = { error: "This reset session has expired. Please verify the OTP again." };
  let payload;
  try {
    payload = jwt.verify(resetToken, JWT_SECRET);
  } catch {
    return res.status(400).json(invalidSession);
  }
  if (payload.purpose !== "password_reset") {
    return res.status(400).json(invalidSession);
  }

  const row = db
    .prepare("SELECT * FROM otp_verifications WHERE id = ? AND user_id = ? AND purpose = 'password_reset'")
    .get(payload.resetId, payload.userId);
  if (!row || !row.verified || row.consumed_at) {
    return res.status(400).json({ error: "This reset session is no longer valid. Please start again." });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  const run = db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, payload.userId);
    // Consuming it here (in addition to the OTP-issuance invalidation above)
    // means this exact reset session can never be replayed even if the
    // token leaked after use.
    db.prepare("UPDATE otp_verifications SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
  });
  run();

  res.json({ ok: true, message: "Password reset successful. You can now log in with your new password." });
});

module.exports = router;
module.exports.issueOtp = issueOtp;
module.exports.canRequestOtp = canRequestOtp;
