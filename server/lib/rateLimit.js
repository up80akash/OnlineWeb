// Minimal in-memory sliding-window rate limiter for the anonymous
// OTP-adjacent endpoints (register, forgot-password, verify-reset-otp).
// This app is explicitly single-process by design (game engines already
// keep authoritative round state in memory -- see README's "Single-process
// design" note), so an in-memory limiter matches the existing architecture;
// there's no Redis in this project and the brief says not to add one just
// for this. Per-email/per-user request limits are enforced separately via
// the otp_verifications table itself (see routes/auth.js, routes/
// account.js), which is durable across restarts -- this module only covers
// the coarser per-IP layer, where losing counters on a restart is an
// acceptable, rare edge case.

const buckets = new Map(); // key -> timestamps[]

function checkLimit(key, max, windowMs) {
  const now = Date.now();
  const timestamps = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= max) {
    buckets.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  buckets.set(key, timestamps);
  return true;
}

// Periodic sweep so the map doesn't grow unbounded over a long-running
// process -- drops any key with no timestamps inside the last hour.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, timestamps] of buckets) {
    if (!timestamps.some((t) => t > cutoff)) buckets.delete(key);
  }
}, 15 * 60 * 1000).unref();

function ipRateLimitMiddleware({ max, windowMs, keyPrefix }) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (!checkLimit(`${keyPrefix}:${ip}`, max, windowMs)) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }
    next();
  };
}

module.exports = { checkLimit, ipRateLimitMiddleware };
