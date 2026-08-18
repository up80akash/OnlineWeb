// Email management for the currently authenticated account -- add a first
// email, verify it, or change to a new one. Deliberately role-agnostic
// (mounted once at /api/account, not duplicated under /api/user, /api/
// admin, /api/subadmin): the operation is always "manage MY OWN email on MY
// OWN row", which is identical regardless of whether the caller is a user,
// sub-admin, or admin, all of whom share the same users table and need this
// to be able to use the email-based forgot-password flow themselves.
//
// A pending new email is never written to users.email until its OTP is
// verified (see routes/auth.js's issueOtp/canRequestOtp, reused here) --
// otherwise a user could silently blank out a working, verified recovery
// email just by typing a new one they don't yet control.

const express = require("express");
const db = require("../db");
const { authenticate } = require("../middleware/auth");
const otpLib = require("../lib/otp");
const { sendOtpEmail } = require("../lib/mailer");
const { issueOtp, canRequestOtp } = require("./auth");

const router = express.Router();
router.use(authenticate);

router.get("/email", (req, res) => {
  res.json({
    email: req.user.email,
    emailVerified: !!req.user.email_verified,
    emailVerifiedAt: req.user.email_verified_at,
  });
});

router.post("/email/send-otp", async (req, res) => {
  const requestedEmail = req.body?.email !== undefined ? otpLib.normalizeEmail(req.body.email) : null;
  const currentEmail = req.user.email;

  let targetEmail;
  if (requestedEmail) {
    // Adding a first email, or changing to a different one.
    if (!otpLib.isValidEmail(requestedEmail)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (requestedEmail === currentEmail && req.user.email_verified) {
      return res.status(400).json({ error: "This email is already verified on your account." });
    }
    const clash = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(requestedEmail, req.user.id);
    if (clash) {
      return res.status(409).json({ error: "This email address is already in use by another account." });
    }
    targetEmail = requestedEmail;
  } else {
    // No email in the body -- resend for the current (unverified) email.
    if (!currentEmail) {
      return res.status(400).json({ error: "Add an email address first." });
    }
    if (req.user.email_verified) {
      return res.status(400).json({ error: "This email is already verified on your account." });
    }
    targetEmail = currentEmail;
  }

  const gate = canRequestOtp(req.user.id, "email_verification");
  if (!gate.ok) {
    return res
      .status(429)
      .json({ error: gate.retryAfterSeconds ? `Please wait ${gate.retryAfterSeconds}s before requesting another OTP.` : "Too many OTP requests. Please try again later." });
  }

  const otp = await issueOtp(req.user.id, "email_verification", targetEmail);
  await sendOtpEmail({ to: targetEmail, name: req.user.name, otp, purpose: "email_verification" });

  res.json({ ok: true, message: `A verification OTP has been sent to ${targetEmail}.`, email: targetEmail });
});

router.post("/email/verify", (req, res) => {
  const otp = String(req.body?.otp || "").trim();
  if (!otp) {
    return res.status(400).json({ error: "Enter the OTP you received." });
  }

  const row = db
    .prepare(
      "SELECT * FROM otp_verifications WHERE user_id = ? AND purpose = 'email_verification' AND consumed_at IS NULL AND verified = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1"
    )
    .get(req.user.id);
  const genericError = { error: "Invalid or expired OTP. Request a new one." };
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

  try {
    const commit = db.transaction(() => {
      db.prepare("UPDATE users SET email = ?, email_verified = 1, email_verified_at = datetime('now') WHERE id = ?").run(
        row.target_email,
        req.user.id
      );
      db.prepare("UPDATE otp_verifications SET verified = 1, consumed_at = datetime('now') WHERE id = ?").run(row.id);
    });
    commit();
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      // Rare race: someone else verified the same email in the gap between
      // this OTP being issued and verified.
      return res.status(409).json({ error: "This email address was just claimed by another account. Please use a different one." });
    }
    throw err;
  }

  res.json({ ok: true, email: row.target_email, emailVerified: true });
});

module.exports = router;
