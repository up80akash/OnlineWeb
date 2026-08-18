const db = require("../../db");

const GAME_ID = "andar_bahar";
const BOT_CODES = ["ANDAR_BOT_001", "ANDAR_BOT_002", "ANDAR_BOT_003", "ANDAR_BOT_004"];

function ensureBotAccounts() {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO game_bot_accounts (game_id, code, display_name) VALUES (?, ?, ?)"
  );
  BOT_CODES.forEach((code, i) => insert.run(GAME_ID, code, `Player${2300 + i}`));
}
ensureBotAccounts();

function activeBots() {
  return db.prepare("SELECT * FROM game_bot_accounts WHERE game_id = ? AND status = 'active'").all(GAME_ID);
}

// Same isolation pattern as every other game's bot module: created before
// the shuffle's matching side is known to anyone, no user_id, no wallet
// ledger entry, ever.
function scheduleBotBets(roundId, cfg, onBotBet) {
  const bots = activeBots();
  if (!bots.length) return;
  const participants = bots.filter(() => Math.random() < 0.55);
  for (const bot of participants) {
    const delay = Math.floor(Math.random() * Math.max(1, cfg.bettingMs - 1000));
    setTimeout(() => {
      const side = Math.random() < 0.5 ? "andar" : "bahar";
      const span = Math.max(cfg.minBet, Math.min(cfg.maxBet, cfg.minBet * 30)) - cfg.minBet;
      const amount = cfg.minBet + Math.round((Math.random() * span) / 5) * 5;
      const info = db
        .prepare(
          `INSERT INTO game_bets (game_id, round_id, bot_account_id, bet_type, bet_amount, payout_multiplier, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`
        )
        .run(GAME_ID, roundId, bot.id, side, amount, cfg.payoutMultiplier);
      if (onBotBet) onBotBet({ betId: info.lastInsertRowid, botName: bot.display_name, side, amount });
    }, delay);
  }
}

module.exports = { activeBots, scheduleBotBets, BOT_CODES, GAME_ID };
