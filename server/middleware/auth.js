const jwt = require("jsonwebtoken");
const db = require("../db");

const JWT_SECRET = process.env.JWT_SECRET;

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing authentication token." });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.id);
  if (!user) {
    return res.status(401).json({ error: "Account no longer exists." });
  }
  if (user.status === "locked") {
    return res.status(403).json({ error: "Account is locked. Contact the admin." });
  }

  req.user = user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: "You do not have access to this resource." });
    }
    next();
  };
}

module.exports = { authenticate, requireRole, JWT_SECRET };
