const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { authenticate, requireRole } = require("../middleware/auth");
const uploads = require("../lib/uploads");
const wallet = require("../lib/wallet");
const referral = require("../lib/referral");

const router = express.Router();
const PHONE_REGEX = /^[6-9]\d{9}$/;

// Thrown when an approval's guarded UPDATE (... AND status = 'pending')
// matches zero rows -- i.e. the request was already reviewed by the time
// this transaction ran, the defense-in-depth backstop behind the earlier
// plain status check.
class AlreadyReviewedError extends Error {}

router.use(authenticate, requireRole("admin"));

function serializeSubadmin(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    walletBalance: row.wallet_balance,
    isDefault: !!row.is_default_subadmin,
    createdAt: row.created_at,
  };
}

function getSubadmin(id) {
  return db.prepare("SELECT * FROM users WHERE id = ? AND role = 'subadmin'").get(id);
}

// ---- Profile ----
router.get("/me", (req, res) => {
  res.json({
    name: req.user.name,
    phone: req.user.phone,
    walletBalance: req.user.wallet_balance,
  });
});

// ---- Sub-admin management ----
router.get("/subadmins", (req, res) => {
  const rows = db.prepare("SELECT * FROM users WHERE role = 'subadmin' ORDER BY created_at DESC").all();
  res.json(rows.map(serializeSubadmin));
});

// Per-sub-admin performance: how many users they manage, how much of the
// platform's tokens sit in those users' wallets, how fast they turn around
// deposit/withdrawal requests, and how much volume they've approved --
// gives the admin a way to compare sub-admins at a glance rather than
// digging through each one's request history individually.
router.get("/subadmins/performance", (req, res) => {
  const subadmins = db.prepare("SELECT * FROM users WHERE role = 'subadmin' ORDER BY created_at DESC").all();

  const userStats = db.prepare(
    "SELECT COUNT(*) AS userCount, COALESCE(SUM(wallet_balance),0) AS totalUserBalance FROM users WHERE role = 'user' AND sub_admin_id = ?"
  );
  const depositStats = db.prepare(
    `SELECT
       SUM(CASE WHEN ud.status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
       SUM(CASE WHEN ud.status = 'approved' THEN 1 ELSE 0 END) AS approvedCount,
       SUM(CASE WHEN ud.status = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount,
       COALESCE(SUM(CASE WHEN ud.status = 'approved' THEN ud.amount ELSE 0 END),0) AS approvedVolume,
       AVG(CASE WHEN ud.status != 'pending' THEN (julianday(ud.reviewed_at) - julianday(ud.created_at)) * 1440 END) AS avgApprovalMinutes
     FROM user_deposits ud JOIN users u ON u.id = ud.user_id WHERE u.sub_admin_id = ?`
  );
  const withdrawalStats = db.prepare(
    `SELECT
       SUM(CASE WHEN uw.status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
       SUM(CASE WHEN uw.status = 'approved' THEN 1 ELSE 0 END) AS approvedCount,
       SUM(CASE WHEN uw.status = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount,
       COALESCE(SUM(CASE WHEN uw.status = 'approved' THEN uw.amount ELSE 0 END),0) AS approvedVolume,
       AVG(CASE WHEN uw.status != 'pending' THEN (julianday(uw.reviewed_at) - julianday(uw.created_at)) * 1440 END) AS avgApprovalMinutes
     FROM user_withdrawals uw JOIN users u ON u.id = uw.user_id WHERE u.sub_admin_id = ?`
  );

  const result = subadmins.map((s) => {
    const users = userStats.get(s.id);
    const deposits = depositStats.get(s.id);
    const withdrawals = withdrawalStats.get(s.id);
    const approvalTimes = [deposits.avgApprovalMinutes, withdrawals.avgApprovalMinutes].filter((v) => v != null);
    return {
      ...serializeSubadmin(s),
      userCount: users.userCount,
      totalUserBalance: users.totalUserBalance,
      deposits: {
        pending: deposits.pendingCount || 0,
        approved: deposits.approvedCount || 0,
        rejected: deposits.rejectedCount || 0,
        approvedVolume: deposits.approvedVolume,
      },
      withdrawals: {
        pending: withdrawals.pendingCount || 0,
        approved: withdrawals.approvedCount || 0,
        rejected: withdrawals.rejectedCount || 0,
        approvedVolume: withdrawals.approvedVolume,
      },
      avgApprovalMinutes: approvalTimes.length ? Math.round((approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length) * 10) / 10 : null,
    };
  });

  res.json(result);
});

router.post("/subadmins", (req, res) => {
  const { name, phone, password } = req.body || {};

  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ error: "Enter a valid name." });
  }
  if (!PHONE_REGEX.test(String(phone || ""))) {
    return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) {
    return res.status(409).json({ error: "A user with this mobile number already exists." });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare(
      "INSERT INTO users (role, name, phone, password_hash, status, wallet_balance, created_by) VALUES ('subadmin', ?, ?, ?, 'active', 0, ?)"
    )
    .run(String(name).trim(), phone, hash, req.user.id);

  res.status(201).json(serializeSubadmin(getSubadmin(result.lastInsertRowid)));
});

router.delete("/subadmins/:id", (req, res) => {
  const subadmin = getSubadmin(req.params.id);
  if (!subadmin) return res.status(404).json({ error: "Sub-admin not found." });
  if (subadmin.is_default_subadmin) {
    return res.status(400).json({
      error: "This is the default sub-admin new users are assigned to and cannot be deleted. Lock it instead if needed.",
    });
  }

  const userCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE sub_admin_id = ?").get(subadmin.id).n;
  if (userCount > 0) {
    return res.status(400).json({
      error: `Cannot delete: this sub-admin still has ${userCount} user${userCount === 1 ? "" : "s"} assigned. Lock the sub-admin instead, or reassign their users first.`,
    });
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(subadmin.id);
  res.json({ ok: true });
});

router.post("/subadmins/:id/lock", (req, res) => {
  const subadmin = getSubadmin(req.params.id);
  if (!subadmin) return res.status(404).json({ error: "Sub-admin not found." });

  db.prepare("UPDATE users SET status = 'locked' WHERE id = ?").run(subadmin.id);
  res.json(serializeSubadmin(getSubadmin(subadmin.id)));
});

router.post("/subadmins/:id/unlock", (req, res) => {
  const subadmin = getSubadmin(req.params.id);
  if (!subadmin) return res.status(404).json({ error: "Sub-admin not found." });

  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(subadmin.id);
  res.json(serializeSubadmin(getSubadmin(subadmin.id)));
});

router.post("/subadmins/:id/password", (req, res) => {
  const subadmin = getSubadmin(req.params.id);
  if (!subadmin) return res.status(404).json({ error: "Sub-admin not found." });

  const { password } = req.body || {};
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, subadmin.id);
  res.json({ ok: true });
});

// ---- Deposit instructions (shown to users before they submit a deposit) ----
router.get("/deposit-instructions", (req, res) => {
  const row = db.prepare("SELECT * FROM deposit_instructions WHERE id = 1").get();
  res.json({
    minAmount: row.min_amount,
    maxAmount: row.max_amount,
    instructions: row.instructions,
    updatedAt: row.updated_at,
  });
});

router.put("/deposit-instructions", (req, res) => {
  const minAmount = Number(req.body?.minAmount);
  const maxAmount = Number(req.body?.maxAmount);
  const instructions = req.body?.instructions ? String(req.body.instructions).slice(0, 4000) : "";

  if (!Number.isInteger(minAmount) || minAmount <= 0) {
    return res.status(400).json({ error: "Minimum deposit amount must be a positive whole number." });
  }
  if (!Number.isInteger(maxAmount) || maxAmount < minAmount) {
    return res.status(400).json({ error: "Maximum deposit amount must be a whole number greater than or equal to the minimum." });
  }
  if (!instructions.trim()) {
    return res.status(400).json({ error: "Instructions text is required." });
  }

  db.prepare(
    "UPDATE deposit_instructions SET min_amount = ?, max_amount = ?, instructions = ?, updated_by = ?, updated_at = datetime('now') WHERE id = 1"
  ).run(minAmount, maxAmount, instructions.trim(), req.user.id);

  const row = db.prepare("SELECT * FROM deposit_instructions WHERE id = 1").get();
  res.json({ minAmount: row.min_amount, maxAmount: row.max_amount, instructions: row.instructions, updatedAt: row.updated_at });
});

// ---- Wallet ----
router.post("/wallet/mint", (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: "Enter a positive whole number of tokens." });
  }

  const mint = db.transaction(() => {
    db.prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?").run(amount, req.user.id);
    db.prepare("INSERT INTO transactions (type, from_user, to_user, amount) VALUES ('mint', NULL, ?, ?)").run(
      req.user.id,
      amount
    );
  });
  mint();

  const updated = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(req.user.id);
  res.json({ walletBalance: updated.wallet_balance });
});

router.post("/wallet/transfer", (req, res) => {
  const subadminId = Number(req.body?.subadminId);
  const amount = Number(req.body?.amount);

  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: "Enter a positive whole number of tokens." });
  }
  const subadmin = getSubadmin(subadminId);
  if (!subadmin) return res.status(404).json({ error: "Sub-admin not found." });
  if (subadmin.status === "locked") {
    return res.status(400).json({ error: "Cannot transfer tokens to a locked sub-admin." });
  }

  const admin = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(req.user.id);
  if (admin.wallet_balance < amount) {
    return res.status(400).json({ error: "Insufficient balance in your wallet." });
  }

  const transfer = db.transaction(() => {
    db.prepare("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?").run(amount, req.user.id);
    db.prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?").run(amount, subadmin.id);
    db.prepare(
      "INSERT INTO transactions (type, from_user, to_user, amount) VALUES ('transfer', ?, ?, ?)"
    ).run(req.user.id, subadmin.id, amount);
  });
  transfer();

  res.json(serializeSubadmin(getSubadmin(subadmin.id)));
});

router.get("/transactions", (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, fu.name AS from_name, tu.name AS to_name
       FROM transactions t
       LEFT JOIN users fu ON fu.id = t.from_user
       LEFT JOIN users tu ON tu.id = t.to_user
       ORDER BY t.created_at DESC LIMIT 50`
    )
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      type: r.type,
      fromName: r.from_name,
      toName: r.to_name,
      amount: r.amount,
      createdAt: r.created_at,
    }))
  );
});

// ---- Deposit approvals ----
router.get("/deposits", (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db
        .prepare(
          `SELECT d.*, u.name AS subadmin_name, u.phone AS subadmin_phone FROM deposits d
           JOIN users u ON u.id = d.subadmin_id WHERE d.status = ? ORDER BY d.created_at DESC`
        )
        .all(status)
    : db
        .prepare(
          `SELECT d.*, u.name AS subadmin_name, u.phone AS subadmin_phone FROM deposits d
           JOIN users u ON u.id = d.subadmin_id ORDER BY d.created_at DESC`
        )
        .all();

  res.json(
    rows.map((r) => ({
      id: r.id,
      subadminId: r.subadmin_id,
      subadminName: r.subadmin_name,
      subadminPhone: r.subadmin_phone,
      amount: r.amount,
      note: r.note,
      status: r.status,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
    }))
  );
});

router.post("/deposits/:id/approve", (req, res) => {
  const deposit = db.prepare("SELECT * FROM deposits WHERE id = ?").get(req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
  if (deposit.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });

  // The sub-admin's float comes out of the admin's own wallet -- it isn't
  // minted. wallet.transferAdminToSubadmin re-validates the admin's balance
  // fresh inside its own atomic transaction (never trusts req.user.wallet_
  // balance, which was read at the start of the request) and is
  // idempotency-keyed on this specific deposit request, so two concurrent
  // approval clicks -- or a retried request -- can never both succeed or
  // double-apply.
  let approve;
  try {
    approve = db.transaction(() => {
      wallet.transferAdminToSubadmin({
        adminId: req.user.id,
        subadminId: deposit.subadmin_id,
        amount: deposit.amount,
        depositRequestId: deposit.id,
        idempotencyKey: `subadmin_deposit:${deposit.id}`,
      });
      const updated = db.prepare(
        "UPDATE deposits SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ? AND status = 'pending'"
      ).run(req.user.id, deposit.id);
      if (updated.changes === 0) throw new AlreadyReviewedError();
      db.prepare(
        "INSERT INTO transactions (type, from_user, to_user, amount) VALUES ('deposit_approved', ?, ?, ?)"
      ).run(req.user.id, deposit.subadmin_id, deposit.amount);
    });
    approve();
  } catch (err) {
    if (err instanceof wallet.InsufficientBalanceError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof AlreadyReviewedError) {
      return res.status(400).json({ error: "This request has already been reviewed." });
    }
    throw err;
  }

  res.json({ ok: true });
});

router.post("/deposits/:id/reject", (req, res) => {
  const deposit = db.prepare("SELECT * FROM deposits WHERE id = ?").get(req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
  if (deposit.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });

  db.prepare(
    "UPDATE deposits SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?"
  ).run(req.user.id, deposit.id);

  res.json({ ok: true });
});

// ---- User deposit requests (platform-wide oversight) ----
// Distinct from "Deposit approvals" above: those are sub-admin -> admin
// float top-ups. These are end-user deposit requests, normally approved by
// the user's own sub-admin (see routes/subadmin.js) -- exposed here too so
// the admin has the same full-oversight capability they already have for
// locking/adjusting any user directly, screenshot review included.
function serializeAdminUserDeposit(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userPhone: r.user_phone,
    subAdminId: r.sub_admin_id,
    subAdminName: r.subadmin_name,
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
  const { status, subAdminId } = req.query;
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push("d.status = ?");
    params.push(status);
  }
  if (subAdminId) {
    clauses.push("u.sub_admin_id = ?");
    params.push(Number(subAdminId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT d.*, u.name AS user_name, u.phone AS user_phone, u.sub_admin_id, sa.name AS subadmin_name
       FROM user_deposits d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN users sa ON sa.id = u.sub_admin_id
       ${where}
       ORDER BY d.created_at DESC LIMIT 500`
    )
    .all(...params);

  res.json(rows.map(serializeAdminUserDeposit));
});

router.get("/user-deposits/:id/screenshot", (req, res) => {
  const row = db.prepare("SELECT screenshot_path, screenshot_mime FROM user_deposits WHERE id = ?").get(req.params.id);
  if (!row || !row.screenshot_path) return res.status(404).json({ error: "File not found." });
  uploads.streamUpload(res, row.screenshot_path, row.screenshot_mime);
});

router.post("/user-deposits/:id/approve", (req, res) => {
  const deposit = db
    .prepare(`SELECT d.*, u.sub_admin_id FROM user_deposits d JOIN users u ON u.id = d.user_id WHERE d.id = ?`)
    .get(req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
  if (deposit.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });
  if (!deposit.sub_admin_id) return res.status(400).json({ error: "This user has no sub-admin assigned to fund the deposit." });

  const subadmin = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(deposit.sub_admin_id);
  if (!subadmin || subadmin.wallet_balance < deposit.amount) {
    return res.status(400).json({ error: "The user's sub-admin does not have enough balance to fund this deposit." });
  }

  // Same fairness rule as sub-admin approval: tokens come from that user's
  // assigned sub-admin's own float, not minted by admin fiat. The user's
  // credit goes through wallet.creditDeposit (principal only) so it lands in
  // the unified ledger and can trigger referral qualification/commission.
  const approve = db.transaction(() => {
    db.prepare("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?").run(deposit.amount, deposit.sub_admin_id);
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
  const deposit = db.prepare("SELECT * FROM user_deposits WHERE id = ?").get(req.params.id);
  if (!deposit) return res.status(404).json({ error: "Deposit request not found." });
  if (deposit.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });

  db.prepare(
    "UPDATE user_deposits SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?"
  ).run(req.user.id, deposit.id);

  res.json({ ok: true });
});

// ---- Payment detail requests ----
router.get("/payment-requests", (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db
        .prepare(
          `SELECT p.*, u.name AS subadmin_name, u.phone AS subadmin_phone FROM payment_requests p
           JOIN users u ON u.id = p.subadmin_id WHERE p.status = ? ORDER BY p.created_at DESC`
        )
        .all(status)
    : db
        .prepare(
          `SELECT p.*, u.name AS subadmin_name, u.phone AS subadmin_phone FROM payment_requests p
           JOIN users u ON u.id = p.subadmin_id ORDER BY p.created_at DESC`
        )
        .all();

  res.json(
    rows.map((r) => ({
      id: r.id,
      subadminId: r.subadmin_id,
      subadminName: r.subadmin_name,
      subadminPhone: r.subadmin_phone,
      method: r.method,
      details: r.details,
      status: r.status,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
    }))
  );
});

router.post("/payment-requests/:id/approve", (req, res) => {
  const request = db.prepare("SELECT * FROM payment_requests WHERE id = ?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found." });
  if (request.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });

  db.prepare(
    "UPDATE payment_requests SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?"
  ).run(req.user.id, request.id);

  res.json({ ok: true });
});

router.post("/payment-requests/:id/reject", (req, res) => {
  const request = db.prepare("SELECT * FROM payment_requests WHERE id = ?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found." });
  if (request.status !== "pending") return res.status(400).json({ error: "This request has already been reviewed." });

  db.prepare(
    "UPDATE payment_requests SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?"
  ).run(req.user.id, request.id);

  res.json({ ok: true });
});

// ---- End users (platform-wide directory) ----
function serializeUserRow(u) {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    emailVerified: !!u.email_verified,
    status: u.status,
    walletBalance: u.wallet_balance,
    createdAt: u.created_at,
    subAdminId: u.sub_admin_id,
    subAdminName: u.sub_admin_name,
  };
}

router.get("/users", (req, res) => {
  const { search, status, subAdminId } = req.query;
  const clauses = ["u.role = 'user'"];
  const params = [];

  if (search) {
    clauses.push("(u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status === "active" || status === "locked") {
    clauses.push("u.status = ?");
    params.push(status);
  }
  if (subAdminId) {
    clauses.push("u.sub_admin_id = ?");
    params.push(Number(subAdminId));
  }

  const rows = db
    .prepare(
      `SELECT u.*, sa.name AS sub_admin_name FROM users u
       LEFT JOIN users sa ON sa.id = u.sub_admin_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY u.created_at DESC LIMIT 500`
    )
    .all(...params);

  res.json(rows.map(serializeUserRow));
});

function getAnyUser(id) {
  return db
    .prepare(
      `SELECT u.*, sa.name AS sub_admin_name, sa.phone AS sub_admin_phone FROM users u
       LEFT JOIN users sa ON sa.id = u.sub_admin_id
       WHERE u.id = ? AND u.role = 'user'`
    )
    .get(id);
}

router.get("/users/:id", (req, res) => {
  const user = getAnyUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });

  const deposits = db
    .prepare("SELECT id, amount, note, status, created_at AS createdAt, reviewed_at AS reviewedAt FROM user_deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(user.id);
  const withdrawals = db
    .prepare("SELECT id, amount, payout_details AS payoutDetails, status, created_at AS createdAt, reviewed_at AS reviewedAt FROM user_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(user.id);
  const walletLedger = db
    .prepare(
      `SELECT game_id AS gameId, amount, transaction_type AS transactionType, created_at AS createdAt
       FROM game_wallet_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50`
    )
    .all(user.id);
  const recentBets = db
    .prepare(
      `SELECT game_id AS gameId, bet_type AS betType, bet_amount AS betAmount, status, settled_amount AS settledAmount, created_at AS createdAt
       FROM game_bets WHERE user_id = ? ORDER BY id DESC LIMIT 50`
    )
    .all(user.id);
  const adjustments = db
    .prepare(
      `SELECT ba.amount, ba.reason, ba.balance_before AS balanceBefore, ba.balance_after AS balanceAfter, ba.created_at AS createdAt, admin.name AS adminName
       FROM balance_adjustments ba JOIN users admin ON admin.id = ba.admin_id
       WHERE ba.user_id = ? ORDER BY ba.id DESC LIMIT 50`
    )
    .all(user.id);
  const statusChanges = db
    .prepare(
      `SELECT sc.new_status AS newStatus, sc.reason, sc.created_at AS createdAt, actor.name AS changedByName, actor.role AS changedByRole
       FROM user_status_changes sc JOIN users actor ON actor.id = sc.changed_by
       WHERE sc.user_id = ? ORDER BY sc.id DESC LIMIT 20`
    )
    .all(user.id);

  res.json({
    ...serializeUserRow(user),
    subAdminPhone: user.sub_admin_phone,
    deposits,
    withdrawals,
    walletLedger,
    recentBets,
    adjustments,
    statusChanges,
  });
});

router.post("/users/:id/lock", (req, res) => {
  const user = getAnyUser(req.params.id);
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
  res.json(serializeUserRow(getAnyUser(user.id)));
});

router.post("/users/:id/unlock", (req, res) => {
  const user = getAnyUser(req.params.id);
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
  res.json(serializeUserRow(getAnyUser(user.id)));
});

router.post("/users/:id/transfer", (req, res) => {
  const user = getAnyUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });

  const subAdminId = Number(req.body?.subAdminId);
  if (!Number.isInteger(subAdminId) || subAdminId <= 0) {
    return res.status(400).json({ error: "Select a sub-admin to transfer this user to." });
  }
  const subadmin = getSubadmin(subAdminId);
  if (!subadmin) return res.status(404).json({ error: "Sub-admin not found." });
  if (subadmin.status === "locked") {
    return res.status(400).json({ error: "Cannot transfer a user to a locked sub-admin." });
  }
  if (user.sub_admin_id === subAdminId) {
    return res.status(400).json({ error: "This user is already assigned to that sub-admin." });
  }

  db.prepare("UPDATE users SET sub_admin_id = ? WHERE id = ?").run(subAdminId, user.id);
  res.json(serializeUserRow(getAnyUser(user.id)));
});

router.post("/users/:id/adjust-balance", (req, res) => {
  const user = getAnyUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });

  const amount = Number(req.body?.amount);
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 300) : "";
  if (!Number.isInteger(amount) || amount === 0) {
    return res.status(400).json({ error: "Enter a non-zero whole number of tokens (negative to deduct)." });
  }
  if (!reason) {
    return res.status(400).json({ error: "A reason is required for a manual balance adjustment." });
  }
  if (amount < 0 && user.wallet_balance + amount < 0) {
    return res.status(400).json({ error: "This would take the user's balance below zero." });
  }

  const balanceBefore = user.wallet_balance;
  const balanceAfter = balanceBefore + amount;
  const run = db.transaction(() => {
    const info = db.prepare(
      "INSERT INTO balance_adjustments (user_id, admin_id, amount, reason, balance_before, balance_after) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(user.id, req.user.id, amount, reason, balanceBefore, balanceAfter);
    // Principal-like (never winning_balance) -- see wallet.adjustBalance.
    // Also lands in wallet_transactions for a complete auditable history.
    wallet.adjustBalance({
      userId: user.id,
      amount,
      adjustmentId: info.lastInsertRowid,
      idempotencyKey: `balance_adjustment:${info.lastInsertRowid}`,
    });
  });
  run();

  res.json(serializeUserRow(getAnyUser(user.id)));
});

// ---- Games (cross-game oversight) ----
router.get("/games/history", (req, res) => {
  const rows = db
    .prepare(
      `SELECT gb.id, COALESCE(u.name, ba.display_name) AS player, gb.game_id AS gameSlug, gb.bet_amount AS betAmount,
              CASE WHEN gb.status IN ('won','cashed') THEN 'win' WHEN gb.status = 'lost' THEN 'loss' ELSE 'pending' END AS result,
              gb.settled_amount AS prize, gb.created_at AS createdAt
       FROM game_bets gb
       LEFT JOIN users u ON u.id = gb.user_id
       LEFT JOIN game_bot_accounts ba ON ba.id = gb.bot_account_id
       WHERE gb.status != 'pending'
       ORDER BY gb.created_at DESC LIMIT 100`
    )
    .all();
  res.json(rows);
});

// Each game exposes an identical admin surface (Dashboard/Rounds/Bets/
// Settlements/Configuration/Provably Fair/Bots/Audit Logs/Health) mounted
// under its own game_id -- only games that have shipped a module are
// mounted here, so hitting an unbuilt game's admin routes 404s cleanly
// instead of exposing a broken generic panel.
router.use("/games/aviator", require("../games/aviator/admin"));
router.use("/games/number-prediction", require("../games/number-prediction/admin"));
router.use("/games/andar-bahar", require("../games/andar-bahar/admin"));
router.use("/games/dice-roll", require("../games/dice-roll/admin"));
router.use("/games/coin-flip", require("../games/coin-flip/admin"));

module.exports = router;
