const express = require("express");
const db = require("../db");
const { authenticate, requireRole } = require("../middleware/auth");
const uploads = require("../lib/uploads");
const wallet = require("../lib/wallet");
const referral = require("../lib/referral");

const router = express.Router();

router.use(authenticate, requireRole("user"));

router.get("/me", (req, res) => {
  const subadmin = req.user.sub_admin_id
    ? db.prepare("SELECT name, phone FROM users WHERE id = ?").get(req.user.sub_admin_id)
    : null;

  const balances = wallet.currentBalances(req.user.id);

  res.json({
    name: req.user.name,
    phone: req.user.phone,
    status: req.user.status,
    walletBalance: balances.walletBalance,
    depositBalance: balances.depositBalance,
    referralBalance: balances.referralBalance,
    winningBalance: balances.winningBalance,
    playableBalance: balances.playableBalance,
    withdrawableBalance: balances.withdrawableBalance,
    createdAt: req.user.created_at,
    subAdmin: subadmin,
    email: req.user.email,
    emailVerified: !!req.user.email_verified,
  });
});

// ---- Wallet transaction history (deposits, withdrawals, referral
// earnings, admin adjustments -- the general-purpose ledger; game-specific
// bet/win/loss detail stays on the per-game history endpoints) ----
router.get("/wallet/transactions", (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, type, amount, balance_before AS balanceBefore, balance_after AS balanceAfter,
              winning_balance_before AS winningBalanceBefore, winning_balance_after AS winningBalanceAfter,
              referral_balance_before AS referralBalanceBefore, referral_balance_after AS referralBalanceAfter,
              related_type AS relatedType, related_id AS relatedId, status, reference, created_at AS createdAt
       FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200`
    )
    .all(req.user.id);
  res.json(rows);
});

// ---- Referral dashboard ----
router.get("/referral", (req, res) => {
  const stats = referral.referralStats(req.user.id);
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({ ...stats, referralLink: `${origin}/login.html?tab=register&ref=${stats.referralCode}` });
});

router.get("/payment-methods", (req, res) => {
  const rows = db
    .prepare(
      "SELECT id, method, details FROM payment_requests WHERE subadmin_id = ? AND status = 'approved' ORDER BY created_at DESC"
    )
    .all(req.user.sub_admin_id);
  res.json(rows);
});

// ---- Deposits ----
function serializeUserDeposit(r) {
  return {
    id: r.id,
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

router.get("/deposit-instructions", (req, res) => {
  const row = db.prepare("SELECT * FROM deposit_instructions WHERE id = 1").get();
  res.json({
    minAmount: row.min_amount,
    maxAmount: row.max_amount,
    instructions: row.instructions,
  });
});

router.get("/deposits", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM user_deposits WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.user.id);
  res.json(rows.map(serializeUserDeposit));
});

router.post("/deposits", uploads.imageUploadMiddleware("screenshot"), (req, res) => {
  const amount = Number(req.body?.amount);
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 300) : null;
  const paymentMethod = req.body?.paymentMethod ? String(req.body.paymentMethod).trim().slice(0, 100) : "";
  const transactionReference = req.body?.transactionReference ? String(req.body.transactionReference).trim().slice(0, 120) : "";

  // Every field below is mandatory -- checked here regardless of what the
  // frontend already enforced, since the frontend can't be trusted.
  const missing = [];
  if (!Number.isInteger(amount) || amount <= 0) missing.push("A valid deposit amount is required.");
  if (!paymentMethod) missing.push("Payment method is required.");
  if (!transactionReference) missing.push("Transaction/reference ID is required.");
  if (!req.file) missing.push("A payment screenshot is required.");
  // Nothing is written to disk until validateImage() passes below, so
  // there's no partial file to clean up on this early return.
  if (missing.length) {
    return res.status(400).json({ error: missing[0], errors: missing });
  }

  const limits = db.prepare("SELECT min_amount, max_amount FROM deposit_instructions WHERE id = 1").get();
  if (amount < limits.min_amount || amount > limits.max_amount) {
    return res.status(400).json({ error: `Deposit amount must be between ${limits.min_amount} and ${limits.max_amount} tokens.` });
  }

  let stored;
  try {
    const { ext, mime } = uploads.validateImage(req.file.buffer, req.file.mimetype);
    const filename = uploads.generateSecureFilename(ext);
    const relPath = uploads.storeFile(req.file.buffer, "deposits", filename);
    stored = { relPath, mime };
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  // Original filename is kept only as a display label (escaped on render by
  // the frontend) -- it is never used to build a filesystem path.
  const originalName = req.file.originalname ? String(req.file.originalname).slice(0, 200) : null;

  const result = db
    .prepare(
      `INSERT INTO user_deposits
        (user_id, amount, note, payment_method, transaction_reference, screenshot_path, screenshot_mime, screenshot_original_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, amount, note, paymentMethod, transactionReference, stored.relPath, stored.mime, originalName);

  const row = db.prepare("SELECT * FROM user_deposits WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(serializeUserDeposit(row));
});

router.get("/deposits/:id/screenshot", (req, res) => {
  const row = db
    .prepare("SELECT screenshot_path, screenshot_mime FROM user_deposits WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user.id);
  // 404 (not 403) for both "doesn't exist" and "not yours" -- doesn't leak
  // which deposit IDs belong to someone else.
  if (!row || !row.screenshot_path) return res.status(404).json({ error: "File not found." });
  uploads.streamUpload(res, row.screenshot_path, row.screenshot_mime);
});

// ---- Withdrawals ----
router.get("/withdrawals", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM user_withdrawals WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.user.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      payoutDetails: r.payout_details,
      status: r.status,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
    }))
  );
});

router.post("/withdrawals", (req, res) => {
  const amount = Number(req.body?.amount);
  const payoutDetails = req.body?.payoutDetails ? String(req.body.payoutDetails).trim().slice(0, 300) : "";

  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: "Enter a positive whole number of tokens." });
  }
  if (!payoutDetails) {
    return res.status(400).json({ error: "Provide where the withdrawal should be sent." });
  }

  // Only genuine winnings (wallet.debitForWithdrawal validates against
  // winning_balance, never total wallet_balance) are withdrawable -- deposit
  // principal is rejected. The balance check happens fresh, inside the same
  // atomic transaction as the insert (never against a value read earlier in
  // the request), so two concurrent withdrawal submissions from the same
  // user can never both succeed against the same winning_balance: if the
  // debit fails, the whole transaction -- including the insert -- rolls back.
  let requestId;
  try {
    const submit = db.transaction(() => {
      const result = db
        .prepare("INSERT INTO user_withdrawals (user_id, amount, payout_details) VALUES (?, ?, ?)")
        .run(req.user.id, amount, payoutDetails);
      requestId = result.lastInsertRowid;
      wallet.debitForWithdrawal({
        userId: req.user.id,
        amount,
        withdrawalId: requestId,
        idempotencyKey: `withdrawal_hold:${requestId}`,
      });
    });
    submit();
  } catch (err) {
    if (err instanceof wallet.InsufficientBalanceError) {
      return res.status(400).json({ error: "Insufficient withdrawable winning balance. You can only withdraw your winnings, not your deposited amount." });
    }
    throw err;
  }

  res.status(201).json({ id: requestId, amount, payoutDetails, status: "pending" });
});

// ---- Support ----
function serializeSupportMessage(r) {
  return {
    id: r.id,
    senderRole: r.sender_role,
    message: r.message,
    hasAttachment: !!r.attachment_path,
    createdAt: r.created_at,
  };
}

router.get("/support", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM support_messages WHERE user_id = ? ORDER BY created_at ASC")
    .all(req.user.id);
  res.json(rows.map(serializeSupportMessage));
});

router.post("/support", uploads.imageUploadMiddleware("attachment"), (req, res) => {
  const message = req.body?.message ? String(req.body.message).trim().slice(0, 1000) : "";
  if (!message) {
    return res.status(400).json({ error: "Enter a message." });
  }
  if (!req.user.sub_admin_id) {
    return res.status(400).json({ error: "No support agent is assigned to your account yet." });
  }

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
       VALUES (?, 'user', ?, ?, ?, ?)`
    )
    .run(req.user.id, message, attachment.relPath, attachment.mime, attachment.originalName);

  const row = db.prepare("SELECT * FROM support_messages WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(serializeSupportMessage(row));
});

router.get("/support/:id/attachment", (req, res) => {
  const row = db
    .prepare("SELECT attachment_path, attachment_mime FROM support_messages WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user.id);
  if (!row || !row.attachment_path) return res.status(404).json({ error: "File not found." });
  uploads.streamUpload(res, row.attachment_path, row.attachment_mime);
});

module.exports = router;
