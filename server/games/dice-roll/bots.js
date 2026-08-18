const db = require("../../db");

const GAME_ID = "dice_roll";
const BOT_CODES = ["DICE_BOT_001", "DICE_BOT_002", "DICE_BOT_003", "DICE_BOT_004"];

function ensureBotAccounts() {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO game_bot_accounts (game_id, code, display_name) VALUES (?, ?, ?)"
  );
  BOT_CODES.forEach((code, i) => insert.run(GAME_ID, code, `Player${2400 + i}`));
}
ensureBotAccounts();

function activeBots() {
  return db.prepare("SELECT * FROM game_bot_accounts WHERE game_id = ? AND status = 'active'").all(GAME_ID);
}

const BET_TYPES = ["low", "high", "odd", "even", ...Array.from({ length: 6 }, (_, i) => `exact:${i + 1}`)];

function scheduleBotBets(roundId, cfg, onBotBet) {
  const bots = activeBots();
  if (!bots.length) return;
  const participants = bots.filter(() => Math.random() < 0.6);
  for (const bot of participants) {
    const delay = Math.floor(Math.random() * Math.max(1, cfg.bettingMs - 1000));
    setTimeout(() => {
      const betType = BET_TYPES[Math.floor(Math.random() * BET_TYPES.length)];
      const payoutMultiplier = betType.startsWith("exact:") ? cfg.exactPayout : cfg.categoryPayout;
      const span = Math.max(cfg.minBet, Math.min(cfg.maxBet, cfg.minBet * 30)) - cfg.minBet;
      const amount = cfg.minBet + Math.round((Math.random() * span) / 5) * 5;
      const info = db
        .prepare(
          `INSERT INTO game_bets (game_id, round_id, bot_account_id, bet_type, bet_amount, payout_multiplier, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`
        )
        .run(GAME_ID, roundId, bot.id, betType, amount, payoutMultiplier);
      if (onBotBet) onBotBet({ betId: info.lastInsertRowid, botName: bot.display_name, betType, amount });
    }, delay);
  }
}

module.exports = { activeBots, scheduleBotBets, BOT_CODES, GAME_ID, BET_TYPES };
