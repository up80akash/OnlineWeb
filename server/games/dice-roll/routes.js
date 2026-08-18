const express = require("express");
const engine = require("./engine");
const { GameError } = require("../../lib/errors");
const { InsufficientBalanceError, currentBalance } = require("../../lib/wallet");

const router = express.Router();

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      if (err instanceof GameError || err instanceof InsufficientBalanceError) {
        return res.status(err.status || 400).json({ error: err.message });
      }
      throw err;
    }
  };
}

router.get(
  "/state",
  handle((req, res) => {
    const s = engine.publicState();
    const myBets = s.roundId ? engine.myBets(req.user.id, s.roundId) : [];
    res.json({
      state: s,
      myBets,
      recentRounds: engine.recentRounds(20),
      liveActivity: s.roundId ? engine.liveActivity(s.roundId) : [],
      walletBalance: req.user.wallet_balance,
    });
  })
);

router.post(
  "/bet",
  handle((req, res) => {
    const betType = String(req.body?.betType || "");
    const betAmount = Number(req.body?.betAmount);
    const idempotencyKey = req.body?.idempotencyKey ? String(req.body.idempotencyKey) : null;
    const bet = engine.placeBet({ userId: req.user.id, betType, betAmount, idempotencyKey });
    res.status(201).json({ bet, walletBalance: currentBalance(req.user.id) });
  })
);

router.post(
  "/verify",
  handle((req, res) => {
    const { serverSeed, clientSeed, nonce } = req.body || {};
    if (!serverSeed || !clientSeed || !Number.isInteger(nonce)) {
      throw new GameError("serverSeed, clientSeed and nonce are required.");
    }
    res.json(engine.verify(serverSeed, clientSeed, nonce));
  })
);

module.exports = router;
