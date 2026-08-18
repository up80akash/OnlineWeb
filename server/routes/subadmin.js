const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { authenticate, requireRole } = require("../middleware/auth");
const uploads = require("../lib/uploads");
const wallet = require("../lib/wallet");
const referral = require("../lib/referral");

const router = express.Router();

router.use(authenticate, requireRole("subadmin"));

router.get("/me", (req, res) => {
  res.json({
    name: req.user.name,
    phone: req.user.phone,
    status: req.user.status,
    walletBalance: req.user.wallet_balance,
  });
});

router.get("/deposits", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM deposits WHERE subadmin_id = ? ORDER BY created_at DESC")
    .all(req.user.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      note: r.note,
      status: r.status,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
    }))
  );
});

router.post("/deposits", (req, res) => {
  const amount = Number(req.body?.amount);
  const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;

  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: "Enter a positive whole number of tokens." });
  }

  const result = db
    .prepare("INSERT INTO deposits (subadmin_id, amount, note) VALUES (?, ?, ?)")
    .run(req.user.id, amount, note);

  res.status(201).json({ id: result.lastInsertRowid, amount, note, status: "pending" });
});

router.get("/payment-requests", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM payment_requests WHERE subadmin_id = ? ORDER BY created_at DESC")
    .all(req.user.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      method: r.method,
      details: r.details,
      status: r.status,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
    }))
  );
});

router.post("/payment-requests", (req, res) => {
  const method = req.body?.method ? String(req.body.method).trim().slice(0, 100) : "";
  const details = req.body?.details ? String(req.body.details).trim().slice(0, 500) : "";

  if (!method || !details) {
    return res.status(400).json({ error: "Provide both a payment method and its details." });
  }

  const result = db
    .prepare("INSERT INTO payment_requests (subadmin_id, method, details) VALUES (?, ?, ?)")
    .run(req.user.id, method, details);

  res.status(201).json({ id: result.lastInsertRowid, method, details, status: "pending" });
});

// ---- Dashboard ----
// A snapshot for the sub-admin's own scope: how many users they manage, how
// much is sitting in those users' wallets, how many requests are waiting on
// them right now, and how much they've approved recently -- previously the
// Overview tab showed nothing but the sub-admin's own float balance.
router.get("/dashboard", (req, res) => {
  const users = db
    .prepare("SELECT COUNT(*) AS userCount, COALESCE(SUM(wallet_balance),0) AS totalUserBalance FROM users WHERE role = 'user' AND sub_admin_id = ?")
    .get(req.user.id);

  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const deposits = db
    .prepare(
      `SELECT
         SUM(CASE WHEN ud.status = 'pending' THEN 1 ELSE 0 END) AS pending,
         COALESCE(SUM(CASE WHEN ud.status = 'approved' AND ud.reviewed_at >= ? THEN ud.amount ELSE 0 END),0) AS approvedVolume7d
       FROM user_deposits ud JOIN users u ON u.id = ud.user_id WHERE u.sub_admin_id = ?`
    )
    .get(since7d, req.user.id);

  const withdrawals = db
    .prepare(
      `SELECT
         SUM(CASE WHEN uw.status = 'pending' THEN 1 ELSE 0 END) AS pending,
         COALESCE(SUM(CASE WHEN uw.status = 'approved' AND uw.reviewed_at >= ? THEN uw.amount ELSE 0 END),0) AS approvedVolume7d
       FROM user_withdrawals uw JOIN users u ON u.id = uw.user_id WHERE u.sub_admin_id = ?`
    )
    .get(since7d, req.user.id);

  const lockedUsers = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'user' AND sub_admin_id = ? AND status = 'locked'")
    .get(req.user.id);

  const unreadSupport = db
    .prepare(
      `SELECT COUNT(*) AS n FROM support_messages m JOIN users u ON u.id = m.user_id
       WHERE u.sub_admin_id = ? AND m.sender_role = 'user'
       AND m.created_at > COALESCE((SELECT MAX(created_at) FROM support_messages m2 WHERE m2.user_id = m.user_id AND m2.sender_role = 'subadmin'), '0000-00-00')`
    )
    .get(req.user.id);

  res.json({
    userCount: users.userCount,
    lockedUsers: lockedUsers.n,
    totalUserBalance: users.totalUserBalance,
    pendingDeposits: deposits.pending || 0,
    pendingWithdrawals: withdrawals.pending || 0,
    approvedDepositVolume7d: deposits.approvedVolume7d,
    approvedWithdrawalVolume7d: withdrawals.approvedVolume7d,
    unreadSupportThreads: unreadSupport.n,
  });
});

// ---- My users ----
function getOwnUser(req, userId) {
  return db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND sub_admin_id = ?")
    .get(userId, req.user.id);
}

function serializeOwnUser(u) {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    emailVerified: !!u.email_verified,
    status: u.status,
    walletBalance: u.wallet_balance,
    createdAt: u.created_at,
  };
}

router.get("/users", (req, res) => {
  const { search, status } = req.query;
  const clauses = ["role = 'user'", "sub_admin_id = ?"];
  const params = [req.user.id];

  if (search) {
    clauses.push("(name LIKE ? OR phone LIKE ? OR email LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status === "active" || status === "locked") {
    clauses.push("status = ?");
    params.push(status);
  }

  const rows = db
    .prepare(`SELECT * FROM users WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`)
    .all(...params);
  res.json(rows.map(serializeOwnUser));
});

router.get("/users/:id", (req, res) => {
  const user = getOwnUser(req, req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });

  const deposits = db
    .prepare("SELECT id, amount, note, status, created_at AS createdAt, reviewed_at AS reviewedAt FROM user_deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(user.id);
  const withdrawals = db
    .prepare("SELECT id, amount, payout_details AS payoutDetails, status, created_at AS createdAt, reviewed_at AS reviewedAt FROM user_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(user.id);

  res.json({ ...serializeOwnUser(user), deposits, withdrawals });
});

router.post("/users/:id/password", (req, res) => {
  const user = getOwnUser(req, req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });

  const { password } = req.body || {};
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
  res.json({ ok: true });
});

router.post("/users/:id/lock", (req, res) => {
  const user = getOwnUser(req, req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 300) : null;

  const run = db.transaction(() => {
    db.prepare("UPDATE users SET status = 'locked' WHERE id = ?").run(user.id);
    db.prepare("INSERT INTO user_status_changes (user_id, changed_by, new_status, reason) VALUES (?, ?, 'locked', ?)").run(
      user.id,
      req.user.id,
      reason
    );
  });
  run();
  res.json(serializeOwnUser(getOwnUser(req, user.id)));
});

router.post("/users/:id/unlock", (req, res) => {
  const user = getOwnUser(req, req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 300) : null;

  const run = db.transaction(() => {
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    db.prepare("INSERT INTO user_status_changes (user_id, changed_by, new_status, reason) VALUES (?, ?, 'active', ?)").run(
      user.id,
      req.user.id,
      reason
    );
  });
  run();
  res.json(serializeOwnUser(getOwnUser(req, user.id)));
});

// ---- User deposit requests ----
function serializeSubadminUserDeposit(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userPhone: r.user_phone,
    amount: r.amount,
    note: r.note,
    paymentMethod: r.payment_method,
    transactionReference: r.transaction_reference,
    hasScreenshot: !!r.screenshot_path,
    status: r.status,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
  };
}

router.get("/user-deposits", (req, res) => {
  const status = req.query.status;
  const base = `SELECT d.*, u.name AS user_name, u.phone AS user_phone FROM user_deposits d
    JOIN users u ON u.id = d.user_id WHERE u.sub_admin_id = ?`;
  const rows = status
    ? db.prepare(`${base} AND d.status = ? ORDER BY d.created_at DESC`).all(req.user.id, status)
    : db.prepare(`${base} ORDER BY d.created_at DESC`).all(req.user.id);

  res.json(rows.map(serializeSubadminUserDeposit));
});

router.get("/user-deposits/:id/screenshot", (req, res) => {
  const row = db
    .prepare(
      `SELECT d.screenshot_path, d.screenshot_mime FROM user_deposits d
       JOIN users u ON u.id = d.user_id WHERE d.id = ? AND u.sub_admin_id = ?`
    )
    .get(req.params.id, req.user.id);
  if (!row || !row.screenshot_path) return res.status(404).json({ error: "File not found." });
  uploads.streamUpload(res, row.screenshot_path, row.screenshot_mime);
});

router.post("/user-deposits/:id/approve", (req, res) => {
  const deposit = db
    .prepare(
      `SELECT d.* FROM user_deposits d JOIN users u ON u.id = d.user_id
       WHERE d.id = ? AND u.sub_admin_id = ?`
    )
    .get(req.params.id, req.user.id);
  if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
  if (deposit.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });
  if (req.user.wallet_balance < deposit.amount) {
    return res.status(400).json({ error: "Insufficient balance in your wallet to approve this deposit." });
  }

  // Approving credits the user from the sub-admin's own token pool (the same
  // pool the admin tops up via sub-admin deposit requests) -- it doesn't
  // create new tokens. The user's credit goes through wallet.creditDeposit
  // (principal only -- never winning_balance) so it's captured in the
  // unified wallet_transactions ledger and can trigger referral
  // qualification/commission for whoever referred this user.
  const approve = db.transaction(() => {
    db.prepare("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?").run(deposit.amount, req.user.id);
    wallet.creditDeposit({
      userId: deposit.user_id,
      amount: deposit.amount,
      depositId: deposit.id,
      idempotencyKey: `user_deposit:${deposit.id}`,
    });
    db.prepare(
      "UPDATE user_deposits SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?"
    ).run(req.user.id, deposit.id);
    referral.processReferralForDeposit(deposit.id);
  });
  approve();

  res.json({ ok: true });
});

router.post("/user-deposits/:id/reject", (req, res) => {
  const deposit = db
    .prepare(
      `SELECT d.* FROM user_deposits d JOIN users u ON u.id = d.user_id
       WHERE d.id = ? AND u.sub_admin_id = ?`
    )
    .get(req.params.id, req.user.id);
  if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
  if (deposit.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });

  db.prepare(
    "UPDATE user_deposits SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?"
  ).run(req.user.id, deposit.id);

  res.json({ ok: true });
});

// ---- User withdrawal requests ----
router.get("/user-withdrawals", (req, res) => {
  const status = req.query.status;
  const base = `SELECT w.*, u.name AS user_name, u.phone AS user_phone FROM user_withdrawals w
    JOIN users u ON u.id = w.user_id WHERE u.sub_admin_id = ?`;
  const rows = status
    ? db.prepare(`${base} AND w.status = ? ORDER BY w.created_at DESC`).all(req.user.id, status)
    : db.prepare(`${base} ORDER BY w.created_at DESC`).all(req.user.id);

  res.json(
    rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userPhone: r.user_phone,
      amount: r.amount,
      payoutDetails: r.payout_details,
      status: r.status,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
    }))
  );
});

router.post("/user-withdrawals/:id/approve", (req, res) => {
  const withdrawal = db
    .prepare(
      `SELECT w.* FROM user_withdrawals w JOIN users u ON u.id = w.user_id
       WHERE w.id = ? AND u.sub_admin_id = ?`
    )
    .get(req.params.id, req.user.id);
  if (!withdrawal) return res.status(404).json({ error: "Withdrawal request not found." });
  if (withdrawal.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });

  // The user's tokens were already deducted (held) when they submitted the
  // request. Approving means the sub-admin pays the user real money
  // out-of-pocket, so those held tokens come back to the sub-admin's own
  // pool -- the mirror of how deposit approval debits it.
  const approve = db.transaction(() => {
    db.prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?").run(withdrawal.amount, req.user.id);
    db.prepare(
      "UPDATE user_withdrawals SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?"
    ).run(req.user.id, withdrawal.id);
  });
  approve();

  res.json({ ok: true });
});

router.post("/user-withdrawals/:id/reject", (req, res) => {
  const withdrawal = db
    .prepare(
      `SELECT w.* FROM user_withdrawals w JOIN users u ON u.id = w.user_id
       WHERE w.id = ? AND u.sub_admin_id = ?`
    )
    .get(req.params.id, req.user.id);
  if (!withdrawal) return res.status(404).json({ error: "Withdrawal request not found." });
  if (withdrawal.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });

  // Refund the amount that was held (both wallet_balance and winning_balance)
  // when the user submitted the request.
  const reject = db.transaction(() => {
    wallet.refundWithdrawal({
      userId: withdrawal.user_id,
      amount: withdrawal.amount,
      withdrawalId: withdrawal.id,
      idempotencyKey: `withdrawal_reject:${withdrawal.id}`,
    });
    db.prepare(
      "UPDATE user_withdrawals SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?"
    ).run(req.user.id, withdrawal.id);
  });
  reject();

  res.json({ ok: true });
});

// ---- Support ----
router.get("/support/threads", (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.phone,
        (SELECT COUNT(*) FROM support_messages m WHERE m.user_id = u.id) AS message_count,
        (SELECT MAX(created_at) FROM support_messages m WHERE m.user_id = u.id) AS last_message_at
       FROM users u WHERE u.role = 'user' AND u.sub_admin_id = ?
       ORDER BY last_message_at IS NULL, last_message_at DESC`
    )
    .all(req.user.id);

  res.json(
    rows.map((r) => ({
      userId: r.id,
      name: r.name,
      phone: r.phone,
      messageCount: r.message_count,
      lastMessageAt: r.last_message_at,
    }))
  );
});

function serializeSupportMessage(r) {
  return {
    id: r.id,
    senderRole: r.sender_role,
    message: r.message,
    hasAttachment: !!r.attachment_path,
    createdAt: r.created_at,
  };
}

router.get("/support/:userId", (req, res) => {
  const user = getOwnUser(req, req.params.userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  const rows = db
    .prepare("SELECT * FROM support_messages WHERE user_id = ? ORDER BY created_at ASC")
    .all(user.id);

  res.json(rows.map(serializeSupportMessage));
});

router.post("/support/:userId", uploads.imageUploadMiddleware("attachment"), (req, res) => {
  const user = getOwnUser(req, req.params.userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  const message = req.body?.message ? String(req.body.message).trim().slice(0, 1000) : "";
  if (!message) return res.status(400).json({ error: "Enter a message." });

  let attachment = { relPath: null, mime: null, originalName: null };
  if (req.file) {
    try {
      const { ext, mime } = uploads.validateImage(req.file.buffer, req.file.mimetype);
      const filename = uploads.generateSecureFilename(ext);
      attachment.relPath = uploads.storeFile(req.file.buffer, "support", filename);
      attachment.mime = mime;
      attachment.originalName = req.file.originalname ? String(req.file.originalname).slice(0, 200) : null;
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  const result = db
    .prepare(
      `INSERT INTO support_messages (user_id, sender_role, message, attachment_path, attachment_mime, attachment_original_name)
       VALUES (?, 'subadmin', ?, ?, ?, ?)`
    )
    .run(user.id, message, attachment.relPath, attachment.mime, attachment.originalName);

  const row = db.prepare("SELECT * FROM support_messages WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(serializeSupportMessage(row));
});

router.get("/support/:userId/:messageId/attachment", (req, res) => {
  const user = getOwnUser(req, req.params.userId);
  if (!user) return res.status(404).json({ error: "File not found." });

  const row = db
    .prepare("SELECT attachment_path, attachment_mime FROM support_messages WHERE id = ? AND user_id = ?")
    .get(req.params.messageId, user.id);
  if (!row || !row.attachment_path) return res.status(404).json({ error: "File not found." });
  uploads.streamUpload(res, row.attachment_path, row.attachment_mime);
});

module.exports = router;
