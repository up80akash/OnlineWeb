const db = require("../../db");
const pf = require("../../lib/provablyFair");
const wallet = require("../../lib/wallet");
const gameConfig = require("../../lib/gameConfig");
const ws = require("../../lib/ws");
const bots = require("./bots");
const { GameError } = require("../../lib/errors");

const GAME_ID = "andar_bahar";
const NAMESPACE = "andar-bahar";

const DEFAULTS = {
  bettingMs: 15_000,
  dealIntervalMs: 700,
  interRoundMs: 4_000,
  minBet: 5,
  maxBet: 3000,
  payoutMultiplier: 1.9,
};

function config() {
  return gameConfig.getActiveConfig(GAME_ID, DEFAULTS).config;
}

const state = {
  roundId: null,
  roundNumber: 0,
  status: "idle", // idle | betting | dealing | resolved
  serverSeed: null,
  serverSeedHash: null,
  clientSeed: null,
  nonce: 0,
  deck: null,
  referenceCard: null,
  dealt: [], // [{ side: 'andar'|'bahar', card }]
  winningSide: null,
  bettingEndsAt: null,
};

let running = false;
let dealTimer = null;

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
    minBet: cfg.minBet,
    maxBet: cfg.maxBet,
    payoutMultiplier: cfg.payoutMultiplier,
    referenceCard: state.referenceCard,
    dealt: state.dealt,
    winningSide: state.status === "resolved" ? state.winningSide : null,
    serverSeed: state.status === "resolved" ? state.serverSeed : null,
  };
}

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

  const deck = pf.deriveShuffledDeck(serverSeed, clientSeed, nonce);
  const referenceCard = deck[0];
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
    deck,
    referenceCard,
    dealt: [],
    winningSide: null,
    bettingEndsAt,
  });

  ws.broadcast(NAMESPACE, "ROUND_CREATED", publicState());
  ws.broadcast(NAMESPACE, "BETTING_OPEN", publicState());
  ws.broadcast(NAMESPACE, "REFERENCE_CARD", { roundId: state.roundId, referenceCard });

  bots.scheduleBotBets(state.roundId, cfg, (bet) => {
    ws.broadcast(NAMESPACE, "BET_PLACED", { roundId: state.roundId, betId: bet.betId, playerName: bet.botName, betType: bet.side, betAmount: bet.amount, isBot: true });
  });

  setTimeout(() => closeBetting(info.lastInsertRowid), cfg.bettingMs);
}

function closeBetting(roundId) {
  if (state.roundId !== roundId || !running) return;
  state.status = "dealing";
  db.prepare("UPDATE game_rounds SET status = 'dealing' WHERE id = ?").run(roundId);
  ws.broadcast(NAMESPACE, "BETTING_CLOSED", { roundId });
  ws.broadcast(NAMESPACE, "RESULT_GENERATED", { roundId });

  const remaining = state.deck.slice(1);
  dealNext(roundId, remaining, 0, "andar");
}

function dealNext(roundId, remaining, index, side) {
  if (state.roundId !== roundId || !running) return;
  if (index >= remaining.length) {
    // Should never happen (a match is mathematically guaranteed within 51
    // remaining cards -- 3 more of the reference rank always exist), but
    // fail safe rather than hang the round forever.
    finishRound(roundId, "andar");
    return;
  }
  const card = remaining[index];
  state.dealt.push({ side, card });
  ws.broadcast(NAMESPACE, side === "andar" ? "ANDAR_CARD" : "BAHAR_CARD", { roundId, card, side, position: index });

  if (pf.rankOf(card) === pf.rankOf(state.referenceCard)) {
    ws.broadcast(NAMESPACE, "MATCH_FOUND", { roundId, card, side });
    dealTimer = setTimeout(() => finishRound(roundId, side), config().dealIntervalMs);
    return;
  }

  const nextSide = side === "andar" ? "bahar" : "andar";
  dealTimer = setTimeout(() => dealNext(roundId, remaining, index + 1, nextSide), config().dealIntervalMs);
}

function finishRound(roundId, winningSide) {
  if (state.roundId !== roundId) return;
  state.status = "resolved";
  state.winningSide = winningSide;
  const resolvedAt = new Date().toISOString();
  db.prepare("UPDATE game_rounds SET status = 'resolved', resolved_at = ?, server_seed = ?, result = ? WHERE id = ?").run(
    resolvedAt,
    state.serverSeed,
    JSON.stringify({ winningSide, referenceCard: state.referenceCard, dealt: state.dealt }),
    roundId
  );

  ws.broadcast(NAMESPACE, "RESULT_REVEALED", { roundId, winningSide, serverSeed: state.serverSeed, serverSeedHash: state.serverSeedHash, clientSeed: state.clientSeed, nonce: state.nonce });

  settleRound(roundId, winningSide);

  ws.broadcast(NAMESPACE, "ROUND_COMPLETED", { roundId, winningSide });

  if (running) setTimeout(runRound, config().interRoundMs);
}

function settleRound(roundId, winningSide) {
  const pending = db.prepare("SELECT * FROM game_bets WHERE round_id = ? AND status = 'pending'").all(roundId);
  for (const bet of pending) {
    const won = bet.bet_type === winningSide;
    if (won) {
      const prize = Math.round(bet.bet_amount * bet.payout_multiplier);
      db.prepare("UPDATE game_bets SET status = 'won', settled_amount = ?, settled_at = datetime('now') WHERE id = ?").run(prize, bet.id);
      if (bet.user_id) {
        wallet.credit({
          gameId: GAME_ID,
          roundId,
          betId: bet.id,
          userId: bet.user_id,
          amount: prize,
          idempotencyKey: `andar_bahar:win:${bet.id}`,
          transactionType: "bet_won",
        });
      }
      ws.broadcast(NAMESPACE, "BET_SETTLED", { betId: bet.id, status: "won", prize, betType: bet.bet_type });
    } else {
      db.prepare("UPDATE game_bets SET status = 'lost', settled_at = datetime('now') WHERE id = ?").run(bet.id);
      ws.broadcast(NAMESPACE, "BET_SETTLED", { betId: bet.id, status: "lost", prize: 0, betType: bet.bet_type });
    }
  }
}

function start() {
  if (running) return;
  running = true;
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
        idempotencyKey: `andar_bahar:refund-restart:${bet.id}`,
      });
    }
  }
  runRound();
}

function stop() {
  running = false;
  if (dealTimer) {
    clearTimeout(dealTimer);
    dealTimer = null;
  }
}

function placeBet({ userId, side, betAmount, idempotencyKey }) {
  if (idempotencyKey) {
    const existing = db.prepare("SELECT * FROM game_bets WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return serializeBet(existing);
  }
  if (state.status !== "betting") throw new GameError("Betting is closed for this round.");
  if (side !== "andar" && side !== "bahar") throw new GameError("Choose Andar or Bahar.");

  const cfg = config();
  if (!Number.isInteger(betAmount) || betAmount < cfg.minBet || betAmount > cfg.maxBet) {
    throw new GameError(`Bet must be between ${cfg.minBet} and ${cfg.maxBet} tokens.`);
  }

  const existingBet = db
    .prepare("SELECT id FROM game_bets WHERE round_id = ? AND user_id = ? AND bet_type = ?")
    .get(state.roundId, userId, side);
  if (existingBet) throw new GameError("You already placed a bet on this side this round.");

  const roundId = state.roundId;
  let bet;
  const run = db.transaction(() => {
    const debit = wallet.debitForBet({
      gameId: GAME_ID,
      roundId,
      betId: null,
      userId,
      amount: betAmount,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:debit` : `andar_bahar:bet:${userId}:${roundId}:${side}:${Date.now()}`,
    });
    const info = db
      .prepare(
        `INSERT INTO game_bets (game_id, round_id, user_id, bet_type, bet_amount, payout_multiplier, status, idempotency_key, winning_portion, referral_portion)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(GAME_ID, roundId, userId, side, betAmount, cfg.payoutMultiplier, idempotencyKey || null, debit.winningPortion, debit.referralPortion);
    bet = db.prepare("SELECT * FROM game_bets WHERE id = ?").get(info.lastInsertRowid);
  });
  run();

  const player = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
  ws.broadcast(NAMESPACE, "BET_PLACED", { roundId, betId: bet.id, playerName: player?.name, betType: side, betAmount, isBot: false });

  return serializeBet(bet);
}

function verify(serverSeed, clientSeed, nonce) {
  const deck = pf.deriveShuffledDeck(serverSeed, clientSeed, nonce);
  const referenceCard = deck[0];
  const remaining = deck.slice(1);
  const dealt = [];
  let side = "andar";
  let winningSide = null;
  for (const card of remaining) {
    dealt.push({ side, card });
    if (pf.rankOf(card) === pf.rankOf(referenceCard)) {
      winningSide = side;
      break;
    }
    side = side === "andar" ? "bahar" : "andar";
  }
  return {
    referenceCard,
    dealt,
    winningSide,
    serverSeedHash: pf.hashServerSeed(serverSeed),
    formula: "Deck = Fisher-Yates shuffle of a standard 52-card deck seeded by HMAC_SHA256(server_seed, client_seed:nonce:cursor); reference card = deck[0]; deal alternately Andar/Bahar from deck[1..] until a card's rank matches the reference card's rank.",
  };
}

function serializeBet(row) {
  return {
    id: row.id,
    roundId: row.round_id,
    side: row.bet_type,
    betAmount: row.bet_amount,
    payoutMultiplier: row.payout_multiplier,
    status: row.status,
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
      `SELECT round_number AS roundNumber, result, resolved_at AS resolvedAt
       FROM game_rounds WHERE game_id = ? AND status = 'resolved' ORDER BY id DESC LIMIT ?`
    )
    .all(GAME_ID, limit)
    .map((r) => ({ roundNumber: r.roundNumber, winningSide: JSON.parse(r.result).winningSide, resolvedAt: r.resolvedAt }));
}

function liveActivity(roundId, limit = 30) {
  return db
    .prepare(
      `SELECT gb.id AS betId, gb.bet_type AS betType, gb.bet_amount AS betAmount, gb.status,
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
  verify,
  myBets,
  recentRounds,
  liveActivity,
  getState: () => state,
};
