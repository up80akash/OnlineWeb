const express = require("express");
const engine = require("./engine");
const { GameError } = require("../../lib/errors");
const { InsufficientBalanceError } = require("../../lib/wallet");

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
    const betAmount = Number(req.body?.betAmount);
    const autoCashout = req.body?.autoCashout ? Number(req.body.autoCashout) : 0;
    const idempotencyKey = req.body?.idempotencyKey ? String(req.body.idempotencyKey) : null;
    const bet = engine.placeBet({ userId: req.user.id, betAmount, autoCashout, idempotencyKey });
    res.status(201).json({ bet, walletBalance: require("../../lib/wallet").currentBalance(req.user.id) });
  })
);

router.post(
  "/bet/:id/cashout",
  handle((req, res) => {
    const result = engine.cashout({ userId: req.user.id, betId: Number(req.params.id) });
    res.json(result);
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
