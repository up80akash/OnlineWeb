// SMTP email sending, shared by password-reset and email-verification OTPs
// (and available for any future transactional email). Uses nodemailer --
// the standard, widely-used Node SMTP client -- since this project had no
// email system at all before this feature.
//
// All configuration comes from environment variables; nothing is hardcoded.
// If SMTP isn't configured, sends are skipped (logged, never throwing) so
// local/dev setups without mail credentials don't crash -- the OTP itself
// is still visible via the console fallback in server/routes/auth.js and
// server/routes/account.js callers, exactly like the seeded admin/
// sub-admin bootstrap passwords already printed on first run.

const nodemailer = require("nodemailer");
const { OTP_TTL_MINUTES } = require("./otp");

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USERNAME = process.env.SMTP_USERNAME;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USERNAME;
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || "Fun & Earning";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

let transporter = null;
let warnedNoConfig = false;

function getTransporter() {
  if (!SMTP_HOST || !SMTP_USERNAME || !SMTP_PASSWORD) {
    if (!warnedNoConfig) {
      console.warn(
        "[mailer] SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD are not fully configured -- emails will not actually be sent. See SETUP.md."
      );
      warnedNoConfig = true;
    }
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });
  }
  return transporter;
}

// Returns true if the email was handed off to the SMTP server successfully.
// Never throws -- a mail failure should never crash the request that
// triggered it (registration, forgot-password, etc. all still need to
// succeed and respond).
async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) return false;
  try {
    await t.sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
      to,
      subject,
      text,
      html,
    });
    return true;
  } catch (err) {
    console.error(`[mailer] Failed to send email to ${to}: ${err.message}`);
    return false;
  }
}

function otpEmailTemplate({ name, otp, purpose }) {
  const isVerification = purpose === "email_verification";
  const subject = isVerification ? "Verify your email address" : "Your Password Reset OTP";
  const heading = isVerification ? "Verify Your Email" : "Your Password Reset OTP";
  const bodyLine = isVerification
    ? "Your OTP for verifying your email address is:"
    : "Your OTP for resetting your password is:";

  const text = [
    heading,
    "",
    `Hello ${name},`,
    "",
    bodyLine,
    "",
    otp,
    "",
    `This OTP expires in ${OTP_TTL_MINUTES} minutes.`,
    "",
    isVerification
      ? "If you did not request this, you can safely ignore this email."
      : "If you did not request a password reset, please ignore this email.",
    "",
    "Do not share this OTP with anyone.",
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0f1115;color:#eef0f4;border-radius:16px;">
      <h2 style="margin:0 0 20px;color:#eef0f4;">${heading}</h2>
      <p style="color:#a2a8b8;margin:0 0 4px;">Hello ${escapeHtml(name)},</p>
      <p style="color:#a2a8b8;margin:0 0 20px;">${bodyLine}</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;padding:18px;margin:0 0 20px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.35);border-radius:12px;color:#22d3ee;">${otp}</div>
      <p style="color:#a2a8b8;font-size:0.9em;margin:0 0 8px;">This OTP expires in ${OTP_TTL_MINUTES} minutes.</p>
      <p style="color:#a2a8b8;font-size:0.9em;margin:0 0 8px;">${isVerification ? "If you did not request this, you can safely ignore this email." : "If you did not request a password reset, please ignore this email."}</p>
      <p style="color:#ff8383;font-size:0.9em;font-weight:600;margin:0;">Do not share this OTP with anyone.</p>
    </div>`;

  return { subject, text, html };
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendOtpEmail({ to, name, otp, purpose }) {
  const { subject, text, html } = otpEmailTemplate({ name, otp, purpose });
  const sent = await sendMail({ to, subject, text, html });
  // Console fallback for local/dev and for any delivery failure -- never
  // printed in production, per the "never log OTPs in production" rule.
  if (!IS_PRODUCTION) {
    console.log(`[OTP] ${purpose} code for ${to}: ${otp} (expires in ${OTP_TTL_MINUTES} min)${sent ? "" : " -- SMTP send failed/not configured, showing for local testing only"}`);
  } else if (!sent) {
    console.error(`[OTP] Failed to deliver ${purpose} email to ${to} (SMTP not configured or send failed). Code withheld from logs.`);
  }
  return sent;
}

module.exports = { sendMail, sendOtpEmail };
