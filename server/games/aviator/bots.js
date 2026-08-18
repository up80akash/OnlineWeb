const db = require("../../db");

const GAME_ID = "aviator";
const BOT_CODES = ["AVIATOR_BOT_001", "AVIATOR_BOT_002", "AVIATOR_BOT_003", "AVIATOR_BOT_004", "AVIATOR_BOT_005"];

function ensureBotAccounts() {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO game_bot_accounts (game_id, code, display_name) VALUES (?, ?, ?)"
  );
  BOT_CODES.forEach((code, i) => insert.run(GAME_ID, code, `Player${2100 + i}`));
}
ensureBotAccounts();

function activeBots() {
  return db.prepare("SELECT * FROM game_bot_accounts WHERE game_id = ? AND status = 'active'").all(GAME_ID);
}

// Bots exist only to make the live-activity feed feel populated. They are
// created with a random subset of the pool, a random stake, and (usually) a
// random auto-cashout target -- all decided *before* the round starts flying
// and completely independent of the pre-committed crash multiplier. Bots
// never touch game_wallet_ledger or users.wallet_balance: they have no
// user_id, so they cannot win or lose real tokens, and they never read the
// engine's private crashMultiplier value.
function scheduleBotBets(roundId, cfg, onBotBet) {
  const bots = activeBots();
  if (!bots.length) return;
  const participants = bots.filter(() => Math.random() < 0.55);
  for (const bot of participants) {
    const delay = Math.floor(Math.random() * Math.max(1, cfg.bettingMs - 1200));
    setTimeout(() => {
      const span = Math.max(cfg.minBet, Math.min(cfg.maxBet, cfg.minBet * 40)) - cfg.minBet;
      const amount = cfg.minBet + Math.round((Math.random() * span) / 5) * 5;
      const autoCashout = Math.random() < 0.75 ? Math.round((1.2 + Math.random() * 3.5) * 100) / 100 : null;
      const info = db
        .prepare(
          `INSERT INTO game_bets (game_id, round_id, bot_account_id, bet_type, bet_amount, payout_multiplier, status, meta)
           VALUES (?, ?, ?, 'flight', ?, 0, 'pending', ?)`
        )
        .run(GAME_ID, roundId, bot.id, amount, JSON.stringify({ autoCashout }));
      if (onBotBet) onBotBet({ betId: info.lastInsertRowid, botName: bot.display_name, amount, autoCashout });
    }, delay);
  }
}

module.exports = { activeBots, scheduleBotBets, BOT_CODES, GAME_ID };
