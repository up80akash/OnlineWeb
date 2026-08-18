// Referral code generation/lookup and the reward logic triggered whenever a
// user's deposit is approved. Kept separate from lib/wallet.js (which only
// knows how to move money) so the "who gets paid, how much" business rules
// live in one readable place.
const crypto = require("crypto");
const db = require("../db");
const wallet = require("./wallet");
const { REFERRAL_QUALIFYING_DEPOSIT, REFERRAL_LOW_TIER_REWARD, REFERRAL_SIGNUP_REWARD } = require("./walletConfig");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I -- avoids look-alike mistakes when typed in by hand
const CODE_LENGTH = 8;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

// Lazily assigns a referral code to a user the first time it's needed
// (registration response, or dashboard load for an older account that
// predates this feature). Collision-safe via the unique index; retries on
// the extremely unlikely clash.
function ensureReferralCode(userId) {
  const row = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(userId);
  if (row?.referral_code) return row.referral_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      db.prepare("UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL").run(code, userId);
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) continue; // extremely rare code collision -- retry
      throw err;
    }
    const check = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(userId);
    if (check?.referral_code) return check.referral_code;
  }
  throw new Error("Could not allocate a referral code. Please try again.");
}

function findReferrerByCode(code) {
  if (!code) return null;
  const normalized = String(code).trim().toUpperCase();
  if (!normalized) return null;
  return db.prepare("SELECT id, status FROM users WHERE referral_code = ?").get(normalized) || null;
}

// Called once, right after a new user row is inserted at registration.
// Self-referral is structurally impossible here (the new user has no
// referral_code of their own yet, and referred_id is UNIQUE so a user can
// never be referred twice), but a code that resolves back to the exact same
// account (shouldn't happen, defense in depth) is rejected anyway.
function recordReferral(referredUserId, referrerId, referralCode) {
  if (referrerId === referredUserId) return; // impossible in practice, guarded anyway
  try {
    db.prepare(
      "INSERT INTO referrals (referrer_id, referred_id, referral_code) VALUES (?, ?, ?)"
    ).run(referrerId, referredUserId, referralCode);
    db.prepare("UPDATE users SET referred_by = ? WHERE id = ?").run(referrerId, referredUserId);
  } catch (err) {
    if (!String(err.message).includes("UNIQUE")) throw err;
    // referred_id already has a referral row -- ignore rather than error the
    // registration itself (shouldn't happen since this only runs once, right
    // after insert, but never let a referral-bookkeeping hiccup block signup).
  }
}

// Tiered flat reward: how much a referrer earns for one referred user's
// deposit, based purely on that deposit's amount. Exactly
// REFERRAL_QUALIFYING_DEPOSIT (500) counts as the high tier.
function rewardForDepositAmount(amount) {
  return amount >= REFERRAL_QUALIFYING_DEPOSIT ? REFERRAL_SIGNUP_REWARD : REFERRAL_LOW_TIER_REWARD;
}

// Called from within the SAME db.transaction() that approves a user_deposit
// (subadmin.js / admin.js), *after* wallet.creditDeposit() has already run
// for that deposit. Idempotent per deposit id -- keyed on the deposit's own
// id (not the referral's), so this is safe to call again on a re-processed/
// retried request: wallet.creditReferralReward's idempotency check makes a
// second call for the same deposit id a no-op, and a rejected/pending
// deposit is never processed at all (deposit.status !== 'approved' short-
// circuits above).
//
// Rule: EVERY approved deposit a referred user makes earns their referrer a
// reward, sized by that deposit's own amount (below 500 -> 50 tokens; 500
// or more -> 500 tokens) -- not just their first deposit. The referrals row
// still flips to 'qualified' and stamps reward_granted_at/
// qualifying_deposit_id, but only on the FIRST reward ever paid out for
// that referral -- a simple "has this referral paid off at least once"
// marker for the dashboard, not a gate on further rewards.
function processReferralForDeposit(depositId) {
  const deposit = db.prepare("SELECT * FROM user_deposits WHERE id = ?").get(depositId);
  if (!deposit || deposit.status !== "approved") return;

  const referral = db.prepare("SELECT * FROM referrals WHERE referred_id = ?").get(deposit.user_id);
  if (!referral) return; // this user wasn't referred by anyone

  // Lightweight abuse signal: the same payment proof (transaction/reference
  // ID) being reused between the referrer's own deposits and the referred
  // user's deposit is a common self-referral farming pattern (one real
  // payment, screenshotted twice, claimed as two different people's
  // deposits). This codebase has no device/IP fingerprinting to lean on, so
  // this is the cheapest reliable signal available from existing data --
  // block the reward rather than silently paying out on it.
  if (deposit.transaction_reference) {
    const reused = db
      .prepare(
        `SELECT id FROM user_deposits WHERE user_id = ? AND transaction_reference = ? AND id != ? LIMIT 1`
      )
      .get(referral.referrer_id, deposit.transaction_reference, deposit.id);
    if (reused) return;
  }

  const reward = rewardForDepositAmount(deposit.amount);
  const applied = wallet.creditReferralReward({
    userId: referral.referrer_id,
    amount: reward,
    referralId: referral.id,
    idempotencyKey: `referral_reward:${deposit.id}`,
  });
  if (!applied.alreadyApplied && referral.status === "pending") {
    db.prepare(
      "UPDATE referrals SET status = 'qualified', reward_amount = ?, reward_granted_at = datetime('now'), qualifying_deposit_id = ? WHERE id = ?"
    ).run(reward, deposit.id, referral.id);
  }
}

function referralStats(userId) {
  ensureReferralCode(userId);
  const user = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(userId);

  const referred = db
    .prepare(
      `SELECT r.*, u.name AS referredName, u.phone AS referredPhone, u.created_at AS referredJoinedAt
       FROM referrals r JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = ? ORDER BY r.id DESC`
    )
    .all(userId);

  const earnings = db
    .prepare(
      `SELECT type, COALESCE(SUM(amount),0) AS total FROM wallet_transactions
       WHERE user_id = ? AND type IN ('REFERRAL_REWARD','REFERRAL_COMMISSION') AND status = 'completed'
       GROUP BY type`
    )
    .all(userId);
  const rewardTotal = earnings.find((e) => e.type === "REFERRAL_REWARD")?.total || 0;
  const commissionTotal = earnings.find((e) => e.type === "REFERRAL_COMMISSION")?.total || 0;

  const history = db
    .prepare(
      `SELECT id, type, amount, related_id AS relatedId, created_at AS createdAt FROM wallet_transactions
       WHERE user_id = ? AND type IN ('REFERRAL_REWARD','REFERRAL_COMMISSION') AND status = 'completed'
       ORDER BY id DESC LIMIT 100`
    )
    .all(userId);

  return {
    referralCode: user.referral_code,
    totalReferred: referred.length,
    qualifiedReferred: referred.filter((r) => r.status === "qualified").length,
    rewardEarned: rewardTotal,
    commissionEarned: commissionTotal,
    totalEarned: rewardTotal + commissionTotal,
    referredUsers: referred.map((r) => ({
      name: r.referredName,
      phone: r.referredPhone,
      status: r.status,
      joinedAt: r.referredJoinedAt,
      qualifiedAt: r.reward_granted_at,
    })),
    history,
  };
}

module.exports = { ensureReferralCode, findReferrerByCode, recordReferral, processReferralForDeposit, referralStats };
