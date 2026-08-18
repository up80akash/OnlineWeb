const express = require("express");
const db = require("../db");
const { authenticate, requireRole } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate, requireRole("user"));

// ---- Catalog ----
router.get("/", (req, res) => {
  const games = db
    .prepare("SELECT slug, name, description, entry_fee, win_multiplier, max_bet, status FROM games ORDER BY id")
    .all();
  res.json(
    games.map((g) => ({
      slug: g.slug,
      name: g.name,
      description: g.description,
      entryFee: g.entry_fee,
      winMultiplier: g.win_multiplier,
      maxBet: g.max_bet,
      status: g.status,
    }))
  );
});

router.get("/recent-wins", (req, res) => {
  const wins = db
    .prepare(
      `SELECT COALESCE(u.name, ba.display_name) AS username, gb.game_id AS gameSlug, gb.settled_amount AS prize, gb.settled_at AS createdAt
       FROM game_bets gb
       LEFT JOIN users u ON u.id = gb.user_id
       LEFT JOIN game_bot_accounts ba ON ba.id = gb.bot_account_id
       WHERE gb.status IN ('won','cashed') AND gb.settled_amount > 0
       ORDER BY gb.settled_at DESC LIMIT 20`
    )
    .all();
  res.json(wins);
});

// ---- Per-game routers (mounted individually as each game ships) ----
router.use("/aviator", require("../games/aviator/routes"));
router.use("/number-prediction", require("../games/number-prediction/routes"));
router.use("/andar-bahar", require("../games/andar-bahar/routes"));
router.use("/dice-roll", require("../games/dice-roll/routes"));
router.use("/coin-flip", require("../games/coin-flip/routes"));

module.exports = router;
