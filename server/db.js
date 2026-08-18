const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const db = new Database(path.join(__dirname, "data.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// If an older users table exists (from before the 'user' role and
// sub_admin_id column existed), rebuild it in place and carry the rows over.
const usersTableExists = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
  .get();
if (usersTableExists) {
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!columns.includes("sub_admin_id")) {
    db.exec(`
      ALTER TABLE users RENAME TO users_old;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('admin','subadmin','user')),
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','locked')),
        wallet_balance INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        sub_admin_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (id, role, name, phone, password_hash, status, wallet_balance, created_by, created_at)
        SELECT id, role, name, phone, password_hash, status, wallet_balance, created_by, created_at FROM users_old;
      DROP TABLE users_old;
    `);
  }
}

// Old game system (aviator-engine.js / pooled-engine.js) is retired in favor
// of the per-game modules under server/games/*. Archive the old tables in
// place (rename, never drop) so historical bet/round/wallet-affecting rows
// stay queryable for audits, instead of being destroyed.
function archiveOldGameTables() {
  const rename = (from, to) => {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(from);
    if (exists) db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  };
  rename("aviator_rounds", "archived_aviator_rounds");
  rename("aviator_bets", "archived_aviator_bets");
  rename("pooled_rounds", "archived_pooled_rounds");
  rename("pooled_bets", "archived_pooled_bets");
}
archiveOldGameTables();

// password_resets now also handles email-verification OTPs (not just
// password resets), so it's renamed to the more accurate otp_verifications
// -- a straight rename-in-place, every existing row/column carries over.
(function renameOtpTable() {
  const oldExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='password_resets'").get();
  const newExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='otp_verifications'").get();
  if (oldExists && !newExists) {
    db.exec("ALTER TABLE password_resets RENAME TO otp_verifications");
  }
})();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK(role IN ('admin','subadmin','user')),
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','locked')),
    wallet_balance INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    sub_admin_id INTEGER REFERENCES users(id),
    email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
    email_verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subadmin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK(amount > 0),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payment_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subadmin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('mint','transfer','deposit_approved')),
    from_user INTEGER REFERENCES users(id),
    to_user INTEGER REFERENCES users(id),
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK(amount > 0),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS user_withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK(amount > 0),
    payout_details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by INTEGER REFERENCES users(id)
  );

  -- Direct admin-initiated changes to a user's wallet balance, outside the
  -- normal deposit/withdrawal request flow (e.g. correcting an error,
  -- goodwill credit). Always requires a reason and is never editable after
  -- the fact -- this table is the audit trail for that power.
  CREATE TABLE IF NOT EXISTS balance_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    admin_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    balance_before INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Account-status changes (lock/unlock) on a user, and by whom -- lets an
  -- admin see whether a user was locked by their own sub-admin or overridden
  -- directly by the platform admin.
  CREATE TABLE IF NOT EXISTS user_status_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    changed_by INTEGER NOT NULL REFERENCES users(id),
    new_status TEXT NOT NULL CHECK(new_status IN ('active','locked')),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_role TEXT NOT NULL CHECK(sender_role IN ('user','subadmin')),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    entry_fee INTEGER NOT NULL CHECK(entry_fee > 0),
    win_multiplier REAL NOT NULL,
    max_bet INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'online' CHECK(status IN ('online','offline')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS game_plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_slug TEXT NOT NULL,
    bet_amount INTEGER NOT NULL,
    win INTEGER NOT NULL CHECK(win IN (0,1)),
    detail TEXT NOT NULL,
    prize INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ---- New game platform (aviator, number_prediction, andar_bahar,
  -- dice_roll, coin_flip) -- each game has its own engine/rules/settlement
  -- module under server/games/<slug>/, but they share this ledger-style
  -- schema plus the wallet helper in server/lib/wallet.js. "result" and
  -- "meta" are free-form JSON since each game's round/bet shape differs
  -- (crash multiplier vs. drawn number vs. dealt cards vs. dice/coin face).
  CREATE TABLE IF NOT EXISTS game_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    server_seed TEXT,
    server_seed_hash TEXT NOT NULL,
    client_seed TEXT NOT NULL,
    nonce INTEGER NOT NULL,
    result TEXT,
    meta TEXT,
    betting_ends_at TEXT NOT NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(game_id, round_number)
  );
  CREATE INDEX IF NOT EXISTS idx_game_rounds_game_id ON game_rounds(game_id, id DESC);

  CREATE TABLE IF NOT EXISTS game_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    round_id INTEGER NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    bot_account_id INTEGER REFERENCES game_bot_accounts(id),
    bet_type TEXT NOT NULL,
    bet_amount INTEGER NOT NULL CHECK(bet_amount > 0),
    payout_multiplier REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','won','lost','cashed','void')),
    settled_amount INTEGER NOT NULL DEFAULT 0,
    cashout_multiplier REAL,
    meta TEXT,
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    settled_at TEXT,
    CHECK ((user_id IS NULL) != (bot_account_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_game_bets_round ON game_bets(round_id);
  CREATE INDEX IF NOT EXISTS idx_game_bets_user ON game_bets(user_id, id DESC);

  -- Every game-driven wallet movement (bet placed, won, refunded) is
  -- recorded here in addition to the balance update itself, keyed by an
  -- idempotency_key so a retried/duplicated request can never double-apply.
  CREATE TABLE IF NOT EXISTS game_wallet_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    round_id INTEGER,
    bet_id INTEGER,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'tokens',
    transaction_type TEXT NOT NULL CHECK(transaction_type IN ('bet_placed','bet_won','bet_refunded','cashout')),
    status TEXT NOT NULL DEFAULT 'completed',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_game_ledger_user ON game_wallet_ledger(user_id, id DESC);

  CREATE TABLE IF NOT EXISTS game_bot_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Versioned, audited per-game configuration (payouts, limits, timing).
  -- Only one row per game_id has is_active = 1; changing config inserts a
  -- new version rather than mutating the old one, so history is preserved.
  CREATE TABLE IF NOT EXISTS game_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    config TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
    changed_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(game_id, version)
  );

  CREATE TABLE IF NOT EXISTS game_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT,
    actor_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Single-row, admin-editable copy shown to a user before they submit a
  -- deposit request (min/max amount, accepted methods, UPI/bank steps,
  -- proof-of-payment requirement, processing time). id is pinned to 1 so
  -- there's only ever one active version; history isn't needed here the way
  -- it is for game_config since this is just instructional text, not
  -- something that changes settlement behavior.
  CREATE TABLE IF NOT EXISTS deposit_instructions (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    min_amount INTEGER NOT NULL DEFAULT 100,
    max_amount INTEGER NOT NULL DEFAULT 100000,
    instructions TEXT NOT NULL DEFAULT '',
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Email-delivered OTPs for both password reset and email verification
  -- (adding a second purpose to one table beats standing up a parallel
  -- system with identical hashing/expiry/attempt/single-use mechanics).
  -- Each row is one OTP issuance; a fresh request for the same user+purpose
  -- supersedes any earlier unconsumed row, so only the latest can ever
  -- verify. otp_hash is bcrypt, never the raw code -- the raw OTP only ever
  -- exists in memory long enough to hash it and hand it to the mailer.
  -- target_email is the address the OTP was actually sent to: for password
  -- resets it mirrors users.email; for email verification it's the
  -- candidate address (which may not be saved to users.email yet, e.g. a
  -- pending change from the profile page) -- see routes/account.js.
  CREATE TABLE IF NOT EXISTS otp_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL DEFAULT 'password_reset' CHECK(purpose IN ('password_reset','email_verification')),
    target_email TEXT,
    otp_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    consumed_at TEXT
  );

  -- One row per referrer<->referred relationship, created once at the
  -- referred user's registration and never re-pointed. "qualified" flips
  -- (and reward_granted_at is stamped) the first time the referred user's
  -- deposit total crosses the qualification threshold -- see
  -- REFERRAL_QUALIFYING_DEPOSIT in lib/walletConfig.js. Every deposit after
  -- qualification earns the referrer a commission (tracked via
  -- wallet_transactions rows, not here) but this row's own reward fields
  -- only ever get written once.
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    referral_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','qualified')),
    reward_amount INTEGER,
    reward_granted_at TEXT,
    qualifying_deposit_id INTEGER REFERENCES user_deposits(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (referrer_id != referred_id)
  );
  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id, id DESC);

  -- Unified, general-purpose ledger for every non-game wallet-affecting
  -- event (deposit approved, withdrawal held/paid/refunded, referral reward,
  -- referral commission, admin adjustment) PLUS a mirrored summary row for
  -- every game bet/win/loss/refund already recorded in the game-specific
  -- game_wallet_ledger -- this table is the single place to look for a
  -- user's complete financial history, while game_wallet_ledger remains the
  -- detailed per-game audit trail it always was (untouched, still used by
  -- the 5 game engines' own idempotency checks). balance_before/after and
  -- winning_before/after capture the full before/after snapshot so every row
  -- is independently auditable without replaying history. idempotency_key
  -- prevents any retried/duplicated webhook, approval click, or game event
  -- from ever double-applying.
  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN (
      'DEPOSIT','WITHDRAWAL','GAME_BET','GAME_WIN','GAME_LOSS','GAME_REFUND',
      'REFERRAL_REWARD','REFERRAL_COMMISSION','REFUND','REVERSAL','ADJUSTMENT'
    )),
    amount INTEGER NOT NULL,
    balance_before INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    winning_balance_before INTEGER NOT NULL,
    winning_balance_after INTEGER NOT NULL,
    related_type TEXT,
    related_id INTEGER,
    status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','reversed')),
    reference TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id, id DESC);

`);

// Add-only schema evolution for columns that didn't exist in earlier
// releases. Each ALTER is guarded by a PRAGMA table_info check so re-running
// this on a database that already has the column is a no-op -- never drops
// or renames existing data.
function addColumnIfMissing(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Users: marks the single seeded "subadmin" account that new registrations
// default to (see seedDefaultSubadmin / findSubadminForNewUser below).
addColumnIfMissing("users", "is_default_subadmin", "is_default_subadmin INTEGER NOT NULL DEFAULT 0");

// Users: recovery/contact email. Nullable -- existing accounts predate this
// feature and keep working (phone+password login is untouched); forgot
// password now requires a *verified* email, so an account with no email (or
// an unverified one) simply can't use that flow until it adds one.
addColumnIfMissing("users", "email", "email TEXT");
addColumnIfMissing("users", "email_verified", "email_verified INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "email_verified_at", "email_verified_at TEXT");
// Partial unique index -- many rows can have email = NULL (unset), but any
// two rows that do have an email set can never share the same one.
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL");

// otp_verifications: added when the table still only handled password
// resets (as password_resets) -- 'purpose' distinguishes that from email
// verification now that both share this table; 'target_email' records which
// address a given OTP was actually sent to.
addColumnIfMissing("otp_verifications", "purpose", "purpose TEXT NOT NULL DEFAULT 'password_reset'");
addColumnIfMissing("otp_verifications", "target_email", "target_email TEXT");
// Created here (not in the CREATE TABLE block above) because on an upgrade
// from the old password_resets table, 'purpose' doesn't exist until the
// addColumnIfMissing calls just above have run.
db.exec("CREATE INDEX IF NOT EXISTS idx_otp_verifications_user ON otp_verifications(user_id, purpose, id DESC)");

// user_deposits: proof-of-payment fields for the deposit screenshot upload
// flow. All are nullable at the schema level (older rows predate this
// feature) but routes/user.js requires them on every new submission.
addColumnIfMissing("user_deposits", "payment_method", "payment_method TEXT");
addColumnIfMissing("user_deposits", "transaction_reference", "transaction_reference TEXT");
addColumnIfMissing("user_deposits", "screenshot_path", "screenshot_path TEXT");
addColumnIfMissing("user_deposits", "screenshot_mime", "screenshot_mime TEXT");
addColumnIfMissing("user_deposits", "screenshot_original_name", "screenshot_original_name TEXT");

// support_messages: one optional image attachment per message.
addColumnIfMissing("support_messages", "attachment_path", "attachment_path TEXT");
addColumnIfMissing("support_messages", "attachment_mime", "attachment_mime TEXT");
addColumnIfMissing("support_messages", "attachment_original_name", "attachment_original_name TEXT");

// users.winning_balance: the withdrawable slice of wallet_balance (genuine
// game winnings + referral earnings). wallet_balance keeps its existing
// meaning of TOTAL balance unchanged, so every pre-existing call site that
// reads/spends wallet_balance keeps working exactly as before. Deposit
// principal is never stored directly -- it's always the implicit
// (wallet_balance - winning_balance). Defaults to 0 for every existing row,
// which is the deliberately conservative choice: a balance that predates
// this column can never be silently reclassified as withdrawable winnings
// just because this migration ran -- it stays non-withdrawable deposit
// principal until the user earns a *new* win/referral payout.
addColumnIfMissing("users", "winning_balance", "winning_balance INTEGER NOT NULL DEFAULT 0");

// users: referral program. referral_code is generated lazily (see
// lib/referral.js) the first time it's needed rather than backfilled here,
// so this migration stays a cheap, instant ALTER even on a large table.
// referred_by is set exactly once, at registration, and never changes.
addColumnIfMissing("users", "referral_code", "referral_code TEXT");
addColumnIfMissing("users", "referred_by", "referred_by INTEGER REFERENCES users(id)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL");

// game_bets.winning_portion: how much of this bet's stake was drawn from
// winning_balance (vs. deposit principal) at debit time -- recorded so a
// later refund (round voided, server restarted mid-round) can restore
// *exactly* the deposit/winning split it took, instead of crediting the
// whole refund back as if it were a fresh win.
addColumnIfMissing("game_bets", "winning_portion", "winning_portion INTEGER NOT NULL DEFAULT 0");

// Mirrors game_bets.winning_portion onto the ledger row itself, so
// wallet.js's defense-in-depth idempotent-replay path (a debit call whose
// idempotency key was already applied) can report the correct split without
// needing to join back to game_bets.
addColumnIfMissing("game_wallet_ledger", "winning_portion", "winning_portion INTEGER NOT NULL DEFAULT 0");

// users.referral_balance: a THIRD balance tier sitting alongside
// wallet_balance/winning_balance. Referral rewards/commissions land here
// instead of winning_balance now -- they're playable (spent on bets, same
// as deposit principal) but never directly withdrawable. wallet_balance
// remains the TOTAL (deposit + referral + winning), so
// deposit_balance = wallet_balance - referral_balance - winning_balance
// (still implicit, still never stored). A bet spends deposit_balance first,
// then referral_balance, then winning_balance last -- so both non-
// withdrawable pools are used up before the already-withdrawable balance is
// ever touched. Any WIN, regardless of which pool funded the stake, still
// credits winning_balance in full (same eligibility rule deposit-funded
// wins already followed) -- see wallet.js debitForBet/credit for the exact
// mechanics. Defaults to 0 for every existing row, same conservative
// migration stance as winning_balance above.
addColumnIfMissing("users", "referral_balance", "referral_balance INTEGER NOT NULL DEFAULT 0");

// Mirrors winning_portion: how much of a bet's stake was drawn from
// referral_balance, so a refund (voided bet) can restore the exact 3-way
// split instead of guessing.
addColumnIfMissing("game_bets", "referral_portion", "referral_portion INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("game_wallet_ledger", "referral_portion", "referral_portion INTEGER NOT NULL DEFAULT 0");

// wallet_transactions: extend the before/after snapshot to cover
// referral_balance too, so every row stays independently auditable.
addColumnIfMissing("wallet_transactions", "referral_balance_before", "referral_balance_before INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("wallet_transactions", "referral_balance_after", "referral_balance_after INTEGER NOT NULL DEFAULT 0");

// Stable internal identifiers for the new game platform -- never the
// display name. Each has its own module under server/games/<id>/.
const GAME_IDS = ["aviator", "number_prediction", "andar_bahar", "dice_roll", "coin_flip"];

// `implemented: false` games are seeded but kept offline (not shown in the
// lobby/catalog) until their module under server/games/<slug>/ lands --
// flip to true as each one ships. This is the single switch that controls
// whether GET /api/games exposes it.
const DEFAULT_GAMES = [
  { slug: "aviator", name: "Aviator", description: "Cash out before the plane crashes — the multiplier climbs, you decide when to bail.", entry_fee: 10, win_multiplier: 0, max_bet: 5000, implemented: true },
  { slug: "number_prediction", name: "Number Prediction", description: "Predict the 0-9 winning number, or bet Odd, Even, Small or Big.", entry_fee: 5, win_multiplier: 9.8, max_bet: 3000, implemented: true },
  { slug: "andar_bahar", name: "Andar Bahar", description: "Classic card game — bet Andar or Bahar on which side matches the reference card's rank.", entry_fee: 5, win_multiplier: 1.9, max_bet: 3000, implemented: true },
  { slug: "dice_roll", name: "Dice Roll", description: "Roll a six-sided die — bet the exact number, High/Low, or Odd/Even.", entry_fee: 5, win_multiplier: 5.8, max_bet: 3000, implemented: true },
  { slug: "coin_flip", name: "Coin Flip", description: "Call it in the air — Heads or Tails.", entry_fee: 5, win_multiplier: 1.96, max_bet: 3000, implemented: true },
];

// Old-game catalog rows (dice, coin-flip, spin-wheel, number-guess,
// card-draw, and the previous single-slug aviator entry) are retired along
// with their engines -- no game listing, admin listing, or lobby should
// show them. They have no incoming foreign keys (aviator_rounds etc. only
// ever matched on slug text, and those tables are now archived separately),
// so it's safe to remove the catalog rows outright; only wallet-affecting
// history needed archiving, and that already happened above.
function retireOldGameCatalogRows() {
  const keep = new Set(DEFAULT_GAMES.map((g) => g.slug));
  const rows = db.prepare("SELECT slug FROM games").all();
  const del = db.prepare("DELETE FROM games WHERE slug = ?");
  for (const row of rows) {
    if (!keep.has(row.slug)) del.run(row.slug);
  }
}

function seedGames() {
  retireOldGameCatalogRows();
  const insert = db.prepare(
    "INSERT INTO games (slug, name, description, entry_fee, win_multiplier, max_bet, status) VALUES (@slug, @name, @description, @entry_fee, @win_multiplier, @max_bet, @status)"
  );
  const update = db.prepare(
    "UPDATE games SET name = @name, description = @description, entry_fee = @entry_fee, win_multiplier = @win_multiplier, max_bet = @max_bet, status = @status WHERE slug = @slug"
  );
  for (const g of DEFAULT_GAMES) {
    const row = { ...g, status: g.implemented ? "online" : "offline" };
    const existing = db.prepare("SELECT id FROM games WHERE slug = ?").get(g.slug);
    if (existing) update.run(row);
    else insert.run(row);
  }
}

seedGames();

function seedAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return;

  const phone = process.env.ADMIN_PHONE || "9999999999";
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString("hex");
  const hash = bcrypt.hashSync(password, 10);

  db.prepare(
    "INSERT INTO users (role, name, phone, password_hash, status, wallet_balance) VALUES ('admin', ?, ?, ?, 'active', 0)"
  ).run("Admin", phone, hash);

  console.log("\n================ ADMIN ACCOUNT CREATED ================");
  console.log(`  Phone:    +91 ${phone}`);
  console.log(`  Password: ${password}`);
  console.log("  Save this password now — it will not be shown again.");
  console.log("=========================================================\n");
}

seedAdmin();

// Every fresh install (and every existing install that predates this
// feature) gets exactly one "subadmin" account that new users default to.
// Password follows the same pattern as seedAdmin(): configurable via env
// vars, otherwise randomly generated and printed once -- never a hardcoded
// plaintext secret in source. The account's phone number is the actual
// login credential (this app authenticates by phone, not username), but its
// display name is fixed to "subadmin" so it reads the same way everywhere
// in the admin UI as the brief's "Username: subadmin" convention.
function seedDefaultSubadmin() {
  const existing = db.prepare("SELECT id FROM users WHERE is_default_subadmin = 1 LIMIT 1").get();
  if (existing) return existing.id;

  const phone = process.env.DEFAULT_SUBADMIN_PHONE || "9000000001";
  const clash = db.prepare("SELECT id, role FROM users WHERE phone = ?").get(phone);
  if (clash) {
    if (clash.role === "subadmin") {
      // A subadmin already occupies this phone (e.g. re-run after a manual
      // fix) -- just flag it as the default rather than creating a duplicate.
      db.prepare("UPDATE users SET is_default_subadmin = 1 WHERE id = ?").run(clash.id);
      return clash.id;
    }
    console.warn(`Default subadmin phone ${phone} is already used by a non-subadmin account; skipping default subadmin seed. Set DEFAULT_SUBADMIN_PHONE to a free number.`);
    return null;
  }

  const password = process.env.DEFAULT_SUBADMIN_PASSWORD || crypto.randomBytes(6).toString("hex");
  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare(
      "INSERT INTO users (role, name, phone, password_hash, status, wallet_balance, is_default_subadmin) VALUES ('subadmin', 'subadmin', ?, ?, 'active', 0, 1)"
    )
    .run(phone, hash);

  if (!process.env.DEFAULT_SUBADMIN_PASSWORD) {
    console.log("\n================ DEFAULT SUBADMIN CREATED ================");
    console.log(`  Name:     subadmin`);
    console.log(`  Phone:    +91 ${phone}`);
    console.log(`  Password: ${password}`);
    console.log("  Save this password now — it will not be shown again.");
    console.log("  Every newly registered user is assigned to this sub-admin");
    console.log("  by default until an admin transfers them elsewhere.");
    console.log("=============================================================\n");
  }
  return result.lastInsertRowid;
}

const defaultSubadminId = seedDefaultSubadmin();

// Existing-data migration: any user row that predates this feature (or was
// otherwise left without a sub-admin) is assigned to the default subadmin
// rather than left dangling. Never touches users who already have a valid
// assignment.
if (defaultSubadminId) {
  db.prepare(
    "UPDATE users SET sub_admin_id = ? WHERE role = 'user' AND sub_admin_id IS NULL"
  ).run(defaultSubadminId);
}

function seedDepositInstructions() {
  const existing = db.prepare("SELECT id FROM deposit_instructions WHERE id = 1").get();
  if (existing) return;
  db.prepare(
    `INSERT INTO deposit_instructions (id, min_amount, max_amount, instructions)
     VALUES (1, 100, 100000, ?)`
  ).run(
    [
      "1. Send payment using one of the payment methods listed on the Wallet tab.",
      "2. Note down the transaction/reference ID from your payment app or bank.",
      "3. Take a clear screenshot of the successful payment.",
      "4. Fill in the amount, select the payment method you used, enter the transaction/reference ID, and upload the screenshot.",
      "5. Your sub-admin typically reviews deposit requests within a few hours.",
    ].join("\n")
  );
}
seedDepositInstructions();

function findSubadminForNewUser() {
  if (defaultSubadminId) {
    const def = db
      .prepare("SELECT id FROM users WHERE id = ? AND role = 'subadmin' AND status = 'active'")
      .get(defaultSubadminId);
    if (def) return def;
  }
  // Fall back to the least-loaded active sub-admin if the default one is
  // missing/locked, so registration doesn't hard-fail just because of that.
  return db
    .prepare(
      `SELECT u.id FROM users u
       LEFT JOIN users linked ON linked.sub_admin_id = u.id AND linked.role = 'user'
       WHERE u.role = 'subadmin' AND u.status = 'active'
       GROUP BY u.id
       ORDER BY COUNT(linked.id) ASC, u.id ASC
       LIMIT 1`
    )
    .get();
}

module.exports = db;
module.exports.findSubadminForNewUser = findSubadminForNewUser;
module.exports.GAME_IDS = GAME_IDS;
