const db = require("../../db");
const pf = require("../../lib/provablyFair");
const wallet = require("../../lib/wallet");
const gameConfig = require("../../lib/gameConfig");
const ws = require("../../lib/ws");
const bots = require("./bots");
const { GameError } = require("../../lib/errors");

const GAME_ID = "aviator";
const NAMESPACE = "aviator";

const DEFAULTS = {
  growthK: 0.07,
  houseEdge: 0.03,
  maxCrash: 100,
  bettingMs: 10_000,
  interRoundMs: 4_000,
  tickMs: 150,
  minBet: 10,
  maxBet: 5000,
  maxBetsPerRound: 2,
};

function config() {
  return gameConfig.getActiveConfig(GAME_ID, DEFAULTS).config;
}

const state = {
  roundId: null,
  roundNumber: 0,
  status: "idle", // idle | betting | flying | crashed
  serverSeed: null,
  serverSeedHash: null,
  clientSeed: null,
  nonce: 0,
  crashMultiplier: null,
  bettingEndsAt: null,
  flyingStartedAt: null,
  crashedAt: null,
};

let tickTimer = null;
let running = false;

// ---- Provably fair ----
function computeCrashMultiplier(serverSeed, clientSeed, nonce, houseEdge, maxCrash) {
  const x = pf.deriveFloat(serverSeed, clientSeed, nonce, 0);
  if (x < houseEdge) return 1.0;
  const crash = (1 - houseEdge) / (1 - x);
  return Math.min(maxCrash, Math.round(Math.max(1.0, crash) * 100) / 100);
}

function timeToReach(multiplier, k) {
  if (multiplier <= 1.0) return 0;
  return Math.log(multiplier) / k;
}

function currentMultiplier() {
  if (state.status !== "flying" || !state.flyingStartedAt) return 1.0;
  const elapsedSec = (Date.now() - state.flyingStartedAt) / 1000;
  return Math.exp(config().growthK * Math.max(0, elapsedSec));
}

function publicState() {
  const cfg = config();
  return {
    gameId: GAME_ID,
    roundId: state.roundId,
    roundNumber: state.roundNumber,
    status: state.status,
    serverSeedHash: state.serverSeedHash,
    clientSeed: state.clientSeed,
    nonce: state.nonce,
    bettingEndsAt: state.bettingEndsAt ? new Date(state.bettingEndsAt).toISOString() : null,
    flyingStartedAt: state.flyingStartedAt ? new Date(state.flyingStartedAt).toISOString() : null,
    crashedAt: state.crashedAt ? new Date(state.crashedAt).toISOString() : null,
    growthK: cfg.growthK,
    minBet: cfg.minBet,
    maxBet: cfg.maxBet,
    maxBetsPerRound: cfg.maxBetsPerRound,
    currentMultiplier: state.status === "flying" ? Math.round(currentMultiplier() * 100) / 100 : null,
    crashMultiplier: state.status === "crashed" ? state.crashMultiplier : null,
    serverSeed: state.status === "crashed" ? state.serverSeed : null,
  };
}

// ---- Round lifecycle ----
function nextRoundNumber() {
  const row = db.prepare("SELECT MAX(round_number) AS n FROM game_rounds WHERE game_id = ?").get(GAME_ID);
  return (row.n || 0) + 1;
}

function lastRound() {
  return db.prepare("SELECT * FROM game_rounds WHERE game_id = ? ORDER BY round_number DESC LIMIT 1").get(GAME_ID);
}

function runRound() {
  if (!running) return;
  const cfg = config();
  const prev = lastRound();
  const serverSeed = pf.generateServerSeed();
  const serverSeedHash = pf.hashServerSeed(serverSeed);
  const clientSeed = pf.nextClientSeed(prev?.server_seed, prev?.client_seed);
  const nonce = prev ? prev.nonce + 1 : 1;
  const crash = computeCrashMultiplier(serverSeed, clientSeed, nonce, cfg.houseEdge, cfg.maxCrash);
  const bettingEndsAt = Date.now() + cfg.bettingMs;
  const roundNumber = nextRoundNumber();

  const info = db
    .prepare(
      `INSERT INTO game_rounds (game_id, round_number, status, server_seed_hash, client_seed, nonce, betting_ends_at)
       VALUES (?, ?, 'betting', ?, ?, ?, ?)`
    )
    .run(GAME_ID, roundNumber, serverSeedHash, clientSeed, nonce, new Date(bettingEndsAt).toISOString());

  Object.assign(state, {
    roundId: info.lastInsertRowid,
    roundNumber,
    status: "betting",
    serverSeed,
    serverSeedHash,
    clientSeed,
    nonce,
    crashMultiplier: crash,
    bettingEndsAt,
    flyingStartedAt: null,
    crashedAt: null,
  });

  ws.broadcast(NAMESPACE, "ROUND_CREATED", publicState());
  ws.broadcast(NAMESPACE, "BETTING_OPEN", publicState());

  bots.scheduleBotBets(state.roundId, cfg, (bet) => {
    ws.broadcast(NAMESPACE, "BET_PLACED", { roundId: state.roundId, betId: bet.betId, playerName: bet.botName, betAmount: bet.amount, isBot: true });
  });

  setTimeout(() => startFlying(info.lastInsertRowid, crash), cfg.bettingMs);
}

function startFlying(roundId, crash) {
  if (state.roundId !== roundId || !running) return;
  const cfg = config();
  state.status = "flying";
  state.flyingStartedAt = Date.now();
  db.prepare("UPDATE game_rounds SET status = 'flying' WHERE id = ?").run(roundId);
  ws.broadcast(NAMESPACE, "BETTING_CLOSED", { roundId });
  ws.broadcast(NAMESPACE, "RESULT_GENERATED", { roundId });

  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => tick(roundId), cfg.tickMs);

  const flightMs = Math.max(100, timeToReach(crash, cfg.growthK) * 1000);
  setTimeout(() => crashRound(roundId, crash), flightMs);
}

function tick(roundId) {
  if (state.roundId !== roundId || state.status !== "flying") return;
  const m = Math.round(currentMultiplier() * 100) / 100;
  ws.broadcast(NAMESPACE, "MULTIPLIER_UPDATE", { roundId, multiplier: m });
  autoCashoutSweep(roundId, m);
}

function autoCashoutSweep(roundId, currentMult) {
  const pending = db.prepare("SELECT * FROM game_bets WHERE round_id = ? AND status = 'pending'").all(roundId);
  for (const bet of pending) {
    const meta = bet.meta ? JSON.parse(bet.meta) : {};
    if (meta.autoCashout && currentMult >= meta.autoCashout) {
      settleCashout(bet, meta.autoCashout, "auto");
    }
  }
}

function settleCashout(bet, cashedOutAt, source) {
  const prize = Math.round(bet.bet_amount * cashedOutAt);
  // Atomic claim: only one caller (manual cashout request vs. this sweep)
  // can win the WHERE status = 'pending' race, since better-sqlite3 runs
  // synchronously -- whichever calls .run() first flips the row and the
  // other sees changes === 0 and backs off instead of double-paying.
  const claim = db
    .prepare(
      "UPDATE game_bets SET status = 'cashed', cashout_multiplier = ?, settled_amount = ?, settled_at = datetime('now') WHERE id = ? AND status = 'pending'"
    )
    .run(cashedOutAt, prize, bet.id);
  if (claim.changes === 0) return null;

  if (bet.user_id) {
    wallet.credit({
      gameId: GAME_ID,
      roundId: bet.round_id,
      betId: bet.id,
      userId: bet.user_id,
      amount: prize,
      idempotencyKey: `aviator:cashout:${bet.id}`,
      transactionType: "cashout",
    });
    const player = db.prepare("SELECT name FROM users WHERE id = ?").get(bet.user_id);
    ws.broadcast(NAMESPACE, "CASHOUT", { roundId: bet.round_id, betId: bet.id, playerName: player?.name, multiplier: cashedOutAt, prize, source });
  } else {
    ws.broadcast(NAMESPACE, "CASHOUT", { roundId: bet.round_id, betId: bet.id, isBot: true, multiplier: cashedOutAt, prize, source });
  }
  ws.broadcast(NAMESPACE, "BET_SETTLED", { betId: bet.id, status: "cashed", prize, multiplier: cashedOutAt });
  return { prize, cashedOutAt };
}

function settleActiveBetsAsLost(roundId) {
  const pending = db.prepare("SELECT * FROM game_bets WHERE round_id = ? AND status = 'pending'").all(roundId);
  const markLost = db.prepare("UPDATE game_bets SET status = 'lost', settled_at = datetime('now') WHERE id = ?");
  for (const bet of pending) {
    markLost.run(bet.id);
    ws.broadcast(NAMESPACE, "BET_SETTLED", { betId: bet.id, status: "lost", prize: 0 });
  }
}

function crashRound(roundId, crash) {
  if (state.roundId !== roundId) return;
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  state.status = "crashed";
  state.crashedAt = Date.now();
  db.prepare("UPDATE game_rounds SET status = 'crashed', resolved_at = ?, server_seed = ?, result = ? WHERE id = ?").run(
    new Date(state.crashedAt).toISOString(),
    state.serverSeed,
    JSON.stringify({ crashMultiplier: crash }),
    roundId
  );
  ws.broadcast(NAMESPACE, "CRASH", { roundId, crashMultiplier: crash, serverSeed: state.serverSeed, serverSeedHash: state.serverSeedHash, clientSeed: state.clientSeed, nonce: state.nonce });
  ws.broadcast(NAMESPACE, "RESULT_REVEALED", { roundId, crashMultiplier: crash, serverSeed: state.serverSeed });

  settleActiveBetsAsLost(roundId);

  ws.broadcast(NAMESPACE, "ROUND_COMPLETED", { roundId, crashMultiplier: crash });

  if (running) setTimeout(runRound, config().interRoundMs);
}

function start() {
  if (running) return;
  running = true;
  // Bets left "pending" from a previous process (e.g. a restart mid-round)
  // can never be resolved by a round that no longer exists in memory --
  // refund them rather than silently losing the player's stake.
  const orphaned = db.prepare("SELECT * FROM game_bets WHERE game_id = ? AND status = 'pending'").all(GAME_ID);
  for (const bet of orphaned) {
    db.prepare("UPDATE game_bets SET status = 'void', settled_at = datetime('now') WHERE id = ?").run(bet.id);
    if (bet.user_id) {
      wallet.refundBet({
        gameId: GAME_ID,
        roundId: bet.round_id,
        betId: bet.id,
        userId: bet.user_id,
        amount: bet.bet_amount,
        winningPortion: bet.winning_portion,
        referralPortion: bet.referral_portion,
        idempotencyKey: `aviator:refund-restart:${bet.id}`,
      });
    }
  }
  runRound();
}

function stop() {
  running = false;
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// ---- Player actions ----
function placeBet({ userId, betAmount, autoCashout, idempotencyKey }) {
  if (idempotencyKey) {
    const existing = db.prepare("SELECT * FROM game_bets WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return serializeBet(existing);
  }
  if (state.status !== "betting") throw new GameError("Betting is closed for this round.");

  const cfg = config();
  if (!Number.isInteger(betAmount) || betAmount < cfg.minBet || betAmount > cfg.maxBet) {
    throw new GameError(`Bet must be between ${cfg.minBet} and ${cfg.maxBet} tokens.`);
  }
  if (autoCashout && (autoCashout < 1.01 || autoCashout > cfg.maxCrash)) {
    throw new GameError(`Auto cash-out must be between 1.01x and ${cfg.maxCrash}x.`);
  }
  const existingCount = db
    .prepare("SELECT COUNT(*) AS n FROM game_bets WHERE round_id = ? AND user_id = ?")
    .get(state.roundId, userId).n;
  if (existingCount >= cfg.maxBetsPerRound) {
    throw new GameError(`You can place at most ${cfg.maxBetsPerRound} bets per round.`);
  }

  const roundId = state.roundId;
  let bet;
  const run = db.transaction(() => {
    const debit = wallet.debitForBet({
      gameId: GAME_ID,
      roundId,
      betId: null,
      userId,
      amount: betAmount,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:debit` : `aviator:bet:${userId}:${roundId}:${Date.now()}:${Math.random()}`,
    });
    const info = db
      .prepare(
        `INSERT INTO game_bets (game_id, round_id, user_id, bet_type, bet_amount, payout_multiplier, status, meta, idempotency_key, winning_portion, referral_portion)
         VALUES (?, ?, ?, 'flight', ?, 0, 'pending', ?, ?, ?, ?)`
      )
      .run(GAME_ID, roundId, userId, betAmount, JSON.stringify({ autoCashout: autoCashout || null }), idempotencyKey || null, debit.winningPortion, debit.referralPortion);
    bet = db.prepare("SELECT * FROM game_bets WHERE id = ?").get(info.lastInsertRowid);
  });
  run();

  const player = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
  ws.broadcast(NAMESPACE, "BET_PLACED", { roundId, betId: bet.id, playerName: player?.name, betAmount, isBot: false });

  return serializeBet(bet);
}

function cashout({ userId, betId }) {
  const bet = db.prepare("SELECT * FROM game_bets WHERE id = ? AND user_id = ?").get(betId, userId);
  if (!bet) throw new GameError("Bet not found.", 404);
  if (bet.status !== "pending") throw new GameError("This bet is already settled.");
  if (state.roundId !== bet.round_id || state.status !== "flying") throw new GameError("Round is not flying.");

  const cur = Math.round(currentMultiplier() * 100) / 100;
  if (cur >= state.crashMultiplier) throw new GameError("Too late — the plane already crashed.");

  const result = settleCashout(bet, cur, "manual");
  if (!result) throw new GameError("This bet is already settled.");
  return { ...result, walletBalance: wallet.currentBalance(userId) };
}

function verify(serverSeed, clientSeed, nonce) {
  const cfg = config();
  const crashMultiplier = computeCrashMultiplier(serverSeed, clientSeed, nonce, cfg.houseEdge, cfg.maxCrash);
  return {
    crashMultiplier,
    serverSeedHash: pf.hashServerSeed(serverSeed),
    formula:
      "x = HMAC_SHA256(server_seed, client_seed + ':' + nonce + ':0') -> first 13 hex chars / 2^52; crash = (1 - house_edge) / (1 - x); if x < house_edge => 1.00; result capped at max_crash and rounded to 2dp",
    houseEdge: cfg.houseEdge,
    maxCrash: cfg.maxCrash,
  };
}

// ---- Serialization / read helpers ----
function serializeBet(row) {
  const meta = row.meta ? JSON.parse(row.meta) : {};
  return {
    id: row.id,
    roundId: row.round_id,
    betAmount: row.bet_amount,
    autoCashout: meta.autoCashout || null,
    status: row.status,
    cashedOutAt: row.cashout_multiplier,
    prize: row.settled_amount,
  };
}

function myBets(userId, roundId) {
  return db
    .prepare("SELECT * FROM game_bets WHERE round_id = ? AND user_id = ? ORDER BY id")
    .all(roundId, userId)
    .map(serializeBet);
}

function recentRounds(limit = 20) {
  return db
    .prepare(
      `SELECT round_number AS nonce, result, server_seed_hash AS serverSeedHash, resolved_at AS crashedAt
       FROM game_rounds WHERE game_id = ? AND status = 'crashed' ORDER BY id DESC LIMIT ?`
    )
    .all(GAME_ID, limit)
    .map((r) => ({ ...r, crashMultiplier: JSON.parse(r.result).crashMultiplier }));
}

function liveActivity(roundId, limit = 30) {
  return db
    .prepare(
      `SELECT gb.id AS betId, gb.bet_amount AS betAmount, gb.status, gb.cashout_multiplier AS cashedOutAt,
              COALESCE(u.name, ba.display_name) AS playerName, (gb.bot_account_id IS NOT NULL) AS isBot
       FROM game_bets gb
       LEFT JOIN users u ON u.id = gb.user_id
       LEFT JOIN game_bot_accounts ba ON ba.id = gb.bot_account_id
       WHERE gb.round_id = ? ORDER BY gb.id DESC LIMIT ?`
    )
    .all(roundId, limit);
}

module.exports = {
  GAME_ID,
  NAMESPACE,
  DEFAULTS,
  config,
  start,
  stop,
  publicState,
  placeBet,
  cashout,
  verify,
  myBets,
  recentRounds,
  liveActivity,
  getState: () => state,
};
