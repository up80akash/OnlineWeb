// Reusable OTP helpers, shared by both purposes that need a 6-digit
// email-delivered code: password reset (server/routes/auth.js) and email
// verification (server/routes/account.js). Both read/write the same
// otp_verifications table (see server/db.js), distinguished by `purpose`.
//
// Kept separate from provablyFair.js -- that module's randomness is for
// game fairness/audit (HMAC over committed seeds); this is plain
// unpredictable-secret generation for a one-time code, a different
// requirement with a different threat model.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 5;
const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
// Defense-in-depth on top of the cooldown: even respecting the 60s wait, an
// attacker could still fire ~60 requests/hour at one inbox -- cap it well
// below that.
const MAX_REQUESTS_PER_HOUR = 5;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateOtp() {
  // crypto.randomInt is uniform over [0, 10^OTP_LENGTH) -- avoids the
  // modulo bias a naive `Math.random() * 10**6` would introduce.
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, "0");
}

function hashOtp(otp) {
  // Cost 8 is intentionally lower than the password hashing cost (10): OTPs
  // are short-lived, single-use, and already rate/attempt-limited, so the
  // extra hashing latency buys little beyond what those controls already
  // provide, and this hash runs on every verify request.
  return bcrypt.hashSync(otp, 8);
}

function verifyOtp(otp, hash) {
  return bcrypt.compareSync(String(otp || ""), hash);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

module.exports = {
  OTP_LENGTH,
  OTP_TTL_MINUTES,
  MAX_VERIFY_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  MAX_REQUESTS_PER_HOUR,
  generateOtp,
  hashOtp,
  verifyOtp,
  normalizeEmail,
  isValidEmail,
};
