// Single centralized module for every wallet-affecting operation in the
// app. Every one of the 5 game engines, every deposit approval, every
// withdrawal request, and the referral reward/commission logic all funnel
// through here -- no route or engine ever writes to users.wallet_balance,
// users.winning_balance, or users.referral_balance directly.
//
// Three balances are tracked per user:
//  - wallet_balance: the TOTAL balance (unchanged meaning from the original
//    single-balance design -- every pre-existing display or spend check
//    that reads wallet_balance keeps working as-is).
//  - winning_balance: the WITHDRAWABLE slice of wallet_balance. Every WIN
//    lands here in full, regardless of which balance funded the stake that
//    won it -- a referral-funded win is withdrawable exactly like a
//    deposit-funded win always has been.
//  - referral_balance: a PLAYABLE-BUT-NOT-WITHDRAWABLE slice, funded by
//    referral rewards/commissions. Spent on bets exactly like deposit
//    principal; never directly withdrawable; only becomes withdrawable
//    money by being staked and won (at which point the win amount is
//    credited to winning_balance, same as any other win).
//  - deposit_balance: never stored -- always the implicit
//    (wallet_balance - referral_balance - winning_balance). Deposits grow
//    only wallet_balance, so it's spent *first* on every bet, then
//    referral_balance, then winning_balance last -- both non-withdrawable
//    pools are exhausted before the already-withdrawable pool is ever
//    touched.
//
// Every mutation here is wrapped in a synchronous db.transaction() (better-
// sqlite3) with no `await` between the balance read and the balance write,
// which -- combined with Node's single-threaded event loop -- makes each
// mutation atomic with respect to every other request, including two
// concurrent requests from the same user (e.g. a double-submitted
// withdrawal). Every mutation is additionally idempotency-keyed so a
// retried request (duplicate webhook, double-click, network retry) can
// never double-apply.
const db = require("../db");

class InsufficientBalanceError extends Error {
  constructor(message = "Insufficient wallet balance.") {
    super(message);
    this.code = "INSUFFICIENT_BALANCE";
  }
}

function currentBalance(userId) {
  return db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(userId).wallet_balance;
}

function currentBalances(userId) {
  const row = db.prepare("SELECT wallet_balance, winning_balance, referral_balance FROM users WHERE id = ?").get(userId);
  const depositBalance = row.wallet_balance - row.referral_balance - row.winning_balance;
  return {
    walletBalance: row.wallet_balance,
    winningBalance: row.winning_balance,
    referralBalance: row.referral_balance,
    depositBalance,
    playableBalance: depositBalance + row.referral_balance,
    withdrawableBalance: row.winning_balance,
  };
}

function ledgerEntry(idempotencyKey) {
  return db.prepare("SELECT * FROM game_wallet_ledger WHERE idempotency_key = ?").get(idempotencyKey);
}

function walletTxEntry(idempotencyKey) {
  return db.prepare("SELECT * FROM wallet_transactions WHERE idempotency_key = ?").get(idempotencyKey);
}

// Writes the general-purpose audit row. Called from *inside* the caller's
// own db.transaction() (better-sqlite3 transactions don't nest, so this is
// a plain prepared statement, never its own db.transaction()).
function recordWalletTx({
  userId, type, amount, balanceBefore, balanceAfter, winningBefore, winningAfter,
  referralBefore = 0, referralAfter = 0, relatedType, relatedId, reference, idempotencyKey, status = "completed",
}) {
  db.prepare(
    `INSERT INTO wallet_transactions
      (user_id, type, amount, balance_before, balance_after, winning_balance_before, winning_balance_after,
       referral_balance_before, referral_balance_after, related_type, related_id, status, reference, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, type, amount, balanceBefore, balanceAfter, winningBefore, winningAfter,
    referralBefore, referralAfter, relatedType || null, relatedId || null, status, reference || null, idempotencyKey
  );
}

// ---- Game engine entry points (called by all 5 games identically) ----

// Debits a bet's stake, consuming deposit (principal) balance first, then
// referral_balance, and only reaching into winning_balance once both are
// exhausted. Returns how much was drawn from each so a later refund can
// restore the exact split (see refundBet below).
function debitForBet({ gameId, roundId, betId, userId, amount, idempotencyKey }) {
  const existing = ledgerEntry(idempotencyKey);
  if (existing) {
    const bal = currentBalances(userId);
    return {
      alreadyApplied: true, walletBalance: bal.walletBalance, winningBalance: bal.winningBalance,
      referralBalance: bal.referralBalance, winningPortion: existing.winning_portion || 0, referralPortion: existing.referral_portion || 0,
    };
  }

  let winningPortion = 0;
  let referralPortion = 0;
  const run = db.transaction(() => {
    const user = db.prepare("SELECT wallet_balance, winning_balance, referral_balance FROM users WHERE id = ?").get(userId);
    if (!user || user.wallet_balance < amount) throw new InsufficientBalanceError();

    const depositBefore = user.wallet_balance - user.referral_balance - user.winning_balance;
    const depositPortion = Math.min(depositBefore, amount);
    let remaining = amount - depositPortion;
    referralPortion = Math.min(user.referral_balance, remaining);
    remaining -= referralPortion;
    winningPortion = remaining;

    const walletAfter = user.wallet_balance - amount;
    const referralAfter = user.referral_balance - referralPortion;
    const winningAfter = user.winning_balance - winningPortion;

    db.prepare("UPDATE users SET wallet_balance = ?, winning_balance = ?, referral_balance = ? WHERE id = ?").run(walletAfter, winningAfter, referralAfter, userId);
    db.prepare(
      `INSERT INTO game_wallet_ledger (game_id, round_id, bet_id, user_id, amount, transaction_type, idempotency_key, winning_portion, referral_portion)
       VALUES (?, ?, ?, ?, ?, 'bet_placed', ?, ?, ?)`
    ).run(gameId, roundId, betId, userId, -amount, idempotencyKey, winningPortion, referralPortion);
    recordWalletTx({
      userId, type: "GAME_BET", amount: -amount,
      balanceBefore: user.wallet_balance, balanceAfter: walletAfter,
      winningBefore: user.winning_balance, winningAfter,
      referralBefore: user.referral_balance, referralAfter,
      relatedType: "game_bet", relatedId: betId, reference: gameId, idempotencyKey,
    });
  });
  run();

  const bal = currentBalances(userId);
  return { alreadyApplied: false, walletBalance: bal.walletBalance, winningBalance: bal.winningBalance, referralBalance: bal.referralBalance, winningPortion, referralPortion };
}

// Credits a genuine win (bet_won / cashout) -- the full amount is new,
// withdrawable money, so it's added to winning_balance as well as
// wallet_balance, REGARDLESS of whether the winning stake was funded by
// deposit or referral balance (referral-funded wins are withdrawable
// exactly like deposit-funded wins always have been). Refunds are NOT a
// valid transactionType here anymore (use refundBet) since a refund must
// restore the original 3-way split, not be treated as fresh winnings.
function credit({ gameId, roundId, betId, userId, amount, idempotencyKey, transactionType = "bet_won" }) {
  if (transactionType === "bet_refunded") {
    throw new Error("credit() no longer accepts transactionType 'bet_refunded' -- use wallet.refundBet() instead.");
  }
  const existing = ledgerEntry(idempotencyKey);
  if (existing) {
    const bal = currentBalances(userId);
    return { alreadyApplied: true, walletBalance: bal.walletBalance, winningBalance: bal.winningBalance, referralBalance: bal.referralBalance };
  }

  const run = db.transaction(() => {
    const user = db.prepare("SELECT wallet_balance, winning_balance, referral_balance FROM users WHERE id = ?").get(userId);
    const walletAfter = user.wallet_balance + amount;
    const winningAfter = user.winning_balance + amount;

    db.prepare("UPDATE users SET wallet_balance = ?, winning_balance = ? WHERE id = ?").run(walletAfter, winningAfter, userId);
    db.prepare(
      `INSERT INTO game_wallet_ledger (game_id, round_id, bet_id, user_id, amount, transaction_type, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(gameId, roundId, betId, userId, amount, transactionType, idempotencyKey);
    recordWalletTx({
      userId, type: "GAME_WIN", amount,
      balanceBefore: user.wallet_balance, balanceAfter: walletAfter,
      winningBefore: user.winning_balance, winningAfter,
      referralBefore: user.referral_balance, referralAfter: user.referral_balance,
      relatedType: "game_bet", relatedId: betId, reference: gameId, idempotencyKey,
    });
  });
  run();

  const bal = currentBalances(userId);
  return { alreadyApplied: false, walletBalance: bal.walletBalance, winningBalance: bal.winningBalance, referralBalance: bal.referralBalance };
}

// Reverses a bet that never resolved (round voided / server restarted
// mid-round) -- restores exactly the deposit/referral/winning split
// debitForBet took, instead of crediting the refund as if it were a fresh
// win or dropping it all back into deposit.
function refundBet({ gameId, roundId, betId, userId, amount, winningPortion, referralPortion, idempotencyKey }) {
  const existing = ledgerEntry(idempotencyKey);
  if (existing) {
    const bal = currentBalances(userId);
    return { alreadyApplied: true, walletBalance: bal.walletBalance, winningBalance: bal.winningBalance, referralBalance: bal.referralBalance };
  }

  const wp = Math.max(0, Math.min(Number(winningPortion) || 0, amount));
  const rp = Math.max(0, Math.min(Number(referralPortion) || 0, amount - wp));
  const run = db.transaction(() => {
    const user = db.prepare("SELECT wallet_balance, winning_balance, referral_balance FROM users WHERE id = ?").get(userId);
    const walletAfter = user.wallet_balance + amount;
    const winningAfter = user.winning_balance + wp;
    const referralAfter = user.referral_balance + rp;

    db.prepare("UPDATE users SET wallet_balance = ?, winning_balance = ?, referral_balance = ? WHERE id = ?").run(walletAfter, winningAfter, referralAfter, userId);
    db.prepare(
      `INSERT INTO game_wallet_ledger (game_id, round_id, bet_id, user_id, amount, transaction_type, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'bet_refunded', ?)`
    ).run(gameId, roundId, betId, userId, amount, idempotencyKey);
    recordWalletTx({
      userId, type: "GAME_REFUND", amount,
      balanceBefore: user.wallet_balance, balanceAfter: walletAfter,
      winningBefore: user.winning_balance, winningAfter,
      referralBefore: user.referral_balance, referralAfter,
      relatedType: "game_bet", relatedId: betId, reference: gameId, idempotencyKey,
    });
  });
  run();

  const bal = currentBalances(userId);
  return { alreadyApplied: false, walletBalance: bal.walletBalance, winningBalance: bal.winningBalance, referralBalance: bal.referralBalance };
}

// ---- Deposits ----

// A deposit is principal: it grows wallet_balance but never winning_balance
// or referral_balance -- it only becomes spendable, never directly
// withdrawable.
function creditDeposit({ userId, amount, depositId, idempotencyKey }) {
  const existing = walletTxEntry(idempotencyKey);
  if (existing) return { alreadyApplied: true, walletBalance: currentBalance(userId) };

  const run = db.transaction(() => {
    const user = db.prepare("SELECT wallet_balance, winning_balance, referral_balance FROM users WHERE id = ?").get(userId);
    const walletAfter = user.wallet_balance + amount;
    db.prepare("UPDATE users SET wallet_balance = ? WHERE id = ?").run(walletAfter, userId);
    recordWalletTx({
      userId, type: "DEPOSIT", amount,
      balanceBefore: user.wallet_balance, balanceAfter: walletAfter,
      winningBefore: user.winning_balance, winningAfter: user.winning_balance,
      referralBefore: user.referral_balance, referralAfter: user.referral_balance,
      relatedType: "user_deposit", relatedId: depositId, reference: "deposit_approved", idempotencyKey,
    });
  });
  run();

  return { alreadyApplied: false, walletBalance: currentBalance(userId) };
}

// ---- Withdrawals ----

// Validates and holds a withdrawal amount against winning_balance ONLY --
// never against total wallet_balance and never against referral_balance --
// so deposited principal and unearned referral balance can never be
// withdrawn. Both balances re-read fresh inside the transaction (never
// trusts a value read earlier in the request), so two concurrent withdrawal
// attempts can never both succeed against the same winning_balance.
function debitForWithdrawal({ userId, amount, withdrawalId, idempotencyKey }) {
  const existing = walletTxEntry(idempotencyKey);
  if (existing) return { alreadyApplied: true, walletBalance: currentBalance(userId) };

  const run = db.transaction(() => {
    const user = db.prepare("SELECT wallet_balance, winning_balance, referral_balance FROM users WHERE id = ?").get(userId);
    if (!user || user.winning_balance < amount) {
      throw new InsufficientBalanceError("Insufficient withdrawable winning balance.");
    }
    const walletAfter = user.wallet_balance - amount;
    const winningAfter = user.winning_balance - amount;
    db.prepare("UPDATE users SET wallet_balance = ?, winning_balance = ? WHERE id = ?").run(walletAfter, winningAfter, userId);
    recordWalletTx({
      userId, type: "WITHDRAWAL", amount: -amount,
      balanceBefore: user.wallet_balance, balanceAfter: walletAfter,
      winningBefore: user.winning_balance, winningAfter,
      referralBefore: user.referral_balance, referralAfter: user.referral_balance,
      relatedType: "user_withdrawal", relatedId: withdrawalId, reference: "withdrawal_hold", idempotencyKey,
    });
  });
  run();

  return { alreadyApplied: false, walletBalance: currentBalance(userId) };
}

// Reverses a held withdrawal (request rejected) -- restores both balances,
// mirroring debitForWithdrawal exactly.
function refundWithdrawal({ userId, amount, withdrawalId, idempotencyKey }) {
  const existing = walletTxEntry(idempotencyKey);
  if (existing) return { alreadyApplied: true, walletBalance: currentBalance(userId) };

  const run = db.transaction(() => {
    const user = db.prepare("SELECT wallet_balance, winning_balance, referral_balance FROM users WHERE id = ?").get(userId);
    const walletAfter = user.wallet_balance + amount;
    const winningAfter = user.winning_balance + amount;
    db.prepare("UPDATE users SET wallet_balance = ?, winning_balance = ? WHERE id = ?").run(walletAfter, winningAfter, userId);
    recordWalletTx({
      userId, type: "REFUND", amount,
      balanceBefore: user.wallet_balance, balanceAfter: walletAfter,
      winningBefore: user.winning_balance, winningAfter,
      referralBefore: user.referral_balance, referralAfter: user.referral_balance,
      relatedType: "user_withdrawal", relatedId: withdrawalId, reference: "withdrawal_rejected", idempotencyKey,
    });
  });
  run();

  return { alreadyApplied: false, walletBalance: currentBalance(userId) };
}

// ---- Referral earnings ----
// Both land in referral_balance -- playable immediately, but NOT
// withdrawable until staked and won (see debitForBet/credit above). This is
// the one behavior change from the original design, where these used to
// credit winning_balance directly.

function creditReferralPool({ userId, amount, type, relatedType, relatedId, reference, idempotencyKey }) {
  const existing = walletTxEntry(idempotencyKey);
  if (existing) return { alreadyApplied: true, walletBalance: currentBalance(userId) };

  const run = db.transaction(() => {
    const user = db.prepare("SELECT wallet_balance, winning_balance, referral_balance FROM users WHERE id = ?").get(userId);
    const walletAfter = user.wallet_balance + amount;
    const referralAfter = user.referral_balance + amount;
    db.prepare("UPDATE users SET wallet_balance = ?, referral_balance = ? WHERE id = ?").run(walletAfter, referralAfter, userId);
    recordWalletTx({
      userId, type, amount,
      balanceBefore: user.wallet_balance, balanceAfter: walletAfter,
      winningBefore: user.winning_balance, winningAfter: user.winning_balance,
      referralBefore: user.referral_balance, referralAfter,
      relatedType, relatedId, reference, idempotencyKey,
    });
  });
  run();

  return { alreadyApplied: false, walletBalance: currentBalance(userId) };
}

function creditReferralReward({ userId, amount, referralId, idempotencyKey }) {
  return creditReferralPool({ userId, amount, type: "REFERRAL_REWARD", relatedType: "referral", relatedId: referralId, reference: "referral_signup_reward", idempotencyKey });
}

function creditReferralCommission({ userId, amount, depositId, idempotencyKey }) {
  return creditReferralPool({ userId, amount, type: "REFERRAL_COMMISSION", relatedType: "user_deposit", relatedId: depositId, reference: "referral_commission", idempotencyKey });
}

// ---- Admin manual adjustment ----

// Treated as principal-like (never winning_balance or referral_balance)
// since it's an arbitrary correction/goodwill credit, not a game win or
// referral earning. On a debit, winning_balance is clamped first (most
// protected), then referral_balance, so neither can ever exceed the new
// (lower) wallet_balance.
function adjustBalance({ userId, amount, adjustmentId, idempotencyKey }) {
  const existing = walletTxEntry(idempotencyKey);
  if (existing) return { alreadyApplied: true, walletBalance: currentBalance(userId) };

  const run = db.transaction(() => {
    const user = db.prepare("SELECT wallet_balance, winning_balance, referral_balance FROM users WHERE id = ?").get(userId);
    const walletAfter = user.wallet_balance + amount;
    if (walletAfter < 0) throw new InsufficientBalanceError();
    const winningAfter = Math.min(user.winning_balance, walletAfter);
    const referralAfter = Math.min(user.referral_balance, walletAfter - winningAfter);
    db.prepare("UPDATE users SET wallet_balance = ?, winning_balance = ?, referral_balance = ? WHERE id = ?").run(walletAfter, winningAfter, referralAfter, userId);
    recordWalletTx({
      userId, type: "ADJUSTMENT", amount,
      balanceBefore: user.wallet_balance, balanceAfter: walletAfter,
      winningBefore: user.winning_balance, winningAfter,
      referralBefore: user.referral_balance, referralAfter,
      relatedType: "balance_adjustment", relatedId: adjustmentId, reference: "admin_adjustment", idempotencyKey,
    });
  });
  run();

  return { alreadyApplied: false, walletBalance: currentBalance(userId) };
}

// ---- Admin -> Sub-admin float transfer (subadmin deposit-request approval) ----

// Admin and sub-admin wallets are flat pools -- the deposit/referral/
// winning split is a user-only concept, so this is a plain atomic two-
// sided transfer: debit the admin, credit the sub-admin, both re-read
// fresh inside one transaction (never trusts a value read earlier in the
// request, so two concurrent approvals of the same request can never both
// succeed), both logged to wallet_transactions. There's no dedicated
// ADMIN_TRANSFER type in the schema's CHECK constraint -- reusing
// ADJUSTMENT for both sides (amount sign carries the direction, same
// convention as every other paired debit/credit here) avoids a disruptive
// SQLite table-rebuild migration just to widen an enum; relatedType/
// reference make the audit trail unambiguous regardless.
function transferAdminToSubadmin({ adminId, subadminId, amount, depositRequestId, idempotencyKey }) {
  const existing = walletTxEntry(`${idempotencyKey}:admin`);
  if (existing) return { alreadyApplied: true };

  const run = db.transaction(() => {
    const admin = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(adminId);
    if (!admin || admin.wallet_balance < amount) {
      throw new InsufficientBalanceError("Admin wallet has insufficient balance to approve this deposit request.");
    }
    const subadmin = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(subadminId);
    const adminAfter = admin.wallet_balance - amount;
    const subadminAfter = subadmin.wallet_balance + amount;

    db.prepare("UPDATE users SET wallet_balance = ? WHERE id = ?").run(adminAfter, adminId);
    db.prepare("UPDATE users SET wallet_balance = ? WHERE id = ?").run(subadminAfter, subadminId);

    recordWalletTx({
      userId: adminId, type: "ADJUSTMENT", amount: -amount,
      balanceBefore: admin.wallet_balance, balanceAfter: adminAfter,
      winningBefore: 0, winningAfter: 0, referralBefore: 0, referralAfter: 0,
      relatedType: "subadmin_deposit_request", relatedId: depositRequestId,
      reference: "admin_to_subadmin_transfer_debit", idempotencyKey: `${idempotencyKey}:admin`,
    });
    recordWalletTx({
      userId: subadminId, type: "ADJUSTMENT", amount,
      balanceBefore: subadmin.wallet_balance, balanceAfter: subadminAfter,
      winningBefore: 0, winningAfter: 0, referralBefore: 0, referralAfter: 0,
      relatedType: "subadmin_deposit_request", relatedId: depositRequestId,
      reference: "admin_to_subadmin_transfer_credit", idempotencyKey: `${idempotencyKey}:subadmin`,
    });
  });
  run();

  return { alreadyApplied: false };
}

module.exports = {
  InsufficientBalanceError,
  currentBalance,
  currentBalances,
  debitForBet,
  credit,
  refundBet,
  creditDeposit,
  debitForWithdrawal,
  refundWithdrawal,
  creditReferralReward,
  creditReferralCommission,
  adjustBalance,
  transferAdminToSubadmin,
};
