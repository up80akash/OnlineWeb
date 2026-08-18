const express = require("express");
const db = require("../db");
const gameConfig = require("./gameConfig");
const ws = require("./ws");
const { GameError } = require("./errors");

// Shared admin API surface for every game: Dashboard/Rounds/Bets/
// Settlements/Configuration/Provably Fair/Bots/Audit Logs/Health. This is
// pure oversight/reporting plumbing built on the common game_rounds/
// game_bets/game_config/game_audit_logs tables -- it never generates
// results, validates bets, or settles anything (that stays inside each
// game's own engine.js), and it deliberately exposes no endpoint that can
// change a round's outcome, only configuration going forward.
function createGameAdminRouter(gameId, { defaults, namespace, engine, botCodes = [] }) {
  const router = express.Router();

  router.get("/dashboard", (req, res) => {
    const activeRound = db
      .prepare("SELECT * FROM game_rounds WHERE game_id = ? ORDER BY id DESC LIMIT 1")
      .get(gameId);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS betCount, COALESCE(SUM(bet_amount),0) AS volume, COALESCE(SUM(settled_amount),0) AS payouts
         FROM game_bets WHERE game_id = ? AND created_at >= ? AND user_id IS NOT NULL`
      )
      .get(gameId, since);
    const players = db
      .prepare(
        `SELECT COUNT(DISTINCT user_id) AS n FROM game_bets WHERE game_id = ? AND created_at >= ? AND user_id IS NOT NULL`
      )
      .get(gameId, since);
    res.json({
      gameId,
      activeRound: activeRound ? { id: activeRound.id, roundNumber: activeRound.round_number, status: activeRound.status } : null,
      last24h: { betCount: stats.betCount, volume: stats.volume, payouts: stats.payouts, uniquePlayers: players.n },
      wsConnections: namespace ? ws.connectionCount(namespace) : 0,
      engineRunning: engine ? engine.getState !== undefined : null,
    });
  });

  router.get("/rounds", (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const rows = db
      .prepare("SELECT * FROM game_rounds WHERE game_id = ? ORDER BY id DESC LIMIT ?")
      .all(gameId, limit);
    res.json(
      rows.map((r) => ({
        id: r.id,
        roundNumber: r.round_number,
        status: r.status,
        serverSeedHash: r.server_seed_hash,
        serverSeed: r.server_seed,
        clientSeed: r.client_seed,
        nonce: r.nonce,
        result: r.result ? JSON.parse(r.result) : null,
        bettingEndsAt: r.betting_ends_at,
        resolvedAt: r.resolved_at,
        createdAt: r.created_at,
      }))
    );
  });

  router.get("/rounds/:id", (req, res) => {
    const round = db.prepare("SELECT * FROM game_rounds WHERE id = ? AND game_id = ?").get(req.params.id, gameId);
    if (!round) return res.status(404).json({ error: "Round not found." });
    const bets = db
      .prepare(
        `SELECT gb.*, COALESCE(u.name, ba.display_name) AS playerName, (gb.bot_account_id IS NOT NULL) AS isBot
         FROM game_bets gb LEFT JOIN users u ON u.id = gb.user_id LEFT JOIN game_bot_accounts ba ON ba.id = gb.bot_account_id
         WHERE gb.round_id = ? ORDER BY gb.id`
      )
      .all(round.id);
    res.json({
      round: { ...round, result: round.result ? JSON.parse(round.result) : null },
      bets,
    });
  });

  router.get("/bets", (req, res) => {
    const limit = Math.min(300, Number(req.query.limit) || 100);
    const status = req.query.status;
    const rows = status
      ? db
          .prepare(
            `SELECT gb.*, COALESCE(u.name, ba.display_name) AS playerName, (gb.bot_account_id IS NOT NULL) AS isBot
             FROM game_bets gb LEFT JOIN users u ON u.id = gb.user_id LEFT JOIN game_bot_accounts ba ON ba.id = gb.bot_account_id
             WHERE gb.game_id = ? AND gb.status = ? ORDER BY gb.id DESC LIMIT ?`
          )
          .all(gameId, status, limit)
      : db
          .prepare(
            `SELECT gb.*, COALESCE(u.name, ba.display_name) AS playerName, (gb.bot_account_id IS NOT NULL) AS isBot
             FROM game_bets gb LEFT JOIN users u ON u.id = gb.user_id LEFT JOIN game_bot_accounts ba ON ba.id = gb.bot_account_id
             WHERE gb.game_id = ? ORDER BY gb.id DESC LIMIT ?`
          )
          .all(gameId, limit);
    res.json(rows);
  });

  router.get("/settlements", (req, res) => {
    const limit = Math.min(300, Number(req.query.limit) || 100);
    const rows = db
      .prepare(
        `SELECT gb.*, COALESCE(u.name, ba.display_name) AS playerName, (gb.bot_account_id IS NOT NULL) AS isBot
         FROM game_bets gb LEFT JOIN users u ON u.id = gb.user_id LEFT JOIN game_bot_accounts ba ON ba.id = gb.bot_account_id
         WHERE gb.game_id = ? AND gb.status IN ('won','lost','cashed','void') ORDER BY gb.settled_at DESC LIMIT ?`
      )
      .all(gameId, limit);
    res.json(rows);
  });

  router.get("/config", (req, res) => {
    const active = gameConfig.getActiveConfig(gameId, defaults);
    res.json({ active, defaults, history: gameConfig.configHistory(gameId, 20) });
  });

  router.post("/config", (req, res) => {
    const patch = req.body?.config;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return res.status(400).json({ error: "config must be an object." });
    }
    const current = gameConfig.getActiveConfig(gameId, defaults).config;
    const next = { ...current, ...patch };
    for (const [key, val] of Object.entries(next)) {
      if (typeof defaults[key] === "number" && (typeof val !== "number" || !Number.isFinite(val) || val <= 0)) {
        return res.status(400).json({ error: `Config field "${key}" must be a positive number.` });
      }
    }
    const version = gameConfig.setConfig(gameId, next, req.user.id);
    res.json({ version, config: next });
  });

  router.get("/provably-fair", (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const rows = db
      .prepare(
        `SELECT id, round_number AS roundNumber, server_seed_hash AS serverSeedHash, server_seed AS serverSeed,
                client_seed AS clientSeed, nonce, result, status, resolved_at AS resolvedAt
         FROM game_rounds WHERE game_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(gameId, limit);
    res.json(rows.map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null })));
  });

  router.get("/bots", (req, res) => {
    const accounts = db.prepare("SELECT * FROM game_bot_accounts WHERE game_id = ? ORDER BY id").all(gameId);
    const recentBets = db
      .prepare(
        `SELECT gb.id, gb.round_id AS roundId, gb.bet_amount AS betAmount, gb.status, gb.settled_amount AS settledAmount,
                ba.code AS botCode, gb.created_at AS createdAt
         FROM game_bets gb JOIN game_bot_accounts ba ON ba.id = gb.bot_account_id
         WHERE gb.game_id = ? ORDER BY gb.id DESC LIMIT 50`
      )
      .all(gameId);
    res.json({ accounts, recentBets });
  });

  router.post("/bots/:id/toggle", (req, res) => {
    const bot = db.prepare("SELECT * FROM game_bot_accounts WHERE id = ? AND game_id = ?").get(req.params.id, gameId);
    if (!bot) return res.status(404).json({ error: "Bot account not found." });
    const nextStatus = bot.status === "active" ? "disabled" : "active";
    db.prepare("UPDATE game_bot_accounts SET status = ? WHERE id = ?").run(nextStatus, bot.id);
    gameConfig.audit(gameId, req.user.id, "bot_toggled", { botId: bot.id, code: bot.code, status: nextStatus });
    res.json({ id: bot.id, status: nextStatus });
  });

  // Creates a new bot account for this game using the exact same
  // architecture every existing bot already runs on (game_bot_accounts row,
  // picked up live by the next scheduleBotBets() call in this game's
  // bots.js -- no restart, no separate registration, no wallet or auth
  // setup needed since bots never have a user_id or session). code must be
  // unique across the whole table (existing UNIQUE constraint); display_name
  // is what players see in the live-activity feed.
  router.post("/bots", (req, res) => {
    const code = String(req.body?.code || "").trim().toUpperCase();
    const displayName = String(req.body?.displayName || "").trim();
    if (!code || !/^[A-Z0-9_]{3,40}$/.test(code)) {
      return res.status(400).json({ error: "Bot code must be 3-40 characters: letters, numbers, underscores only." });
    }
    if (!displayName || displayName.length > 60) {
      return res.status(400).json({ error: "Display name is required (max 60 characters)." });
    }
    const clash = db.prepare("SELECT id FROM game_bot_accounts WHERE code = ?").get(code);
    if (clash) return res.status(409).json({ error: "A bot with this code already exists." });

    const info = db
      .prepare("INSERT INTO game_bot_accounts (game_id, code, display_name, status) VALUES (?, ?, ?, 'active')")
      .run(gameId, code, displayName);
    gameConfig.audit(gameId, req.user.id, "bot_created", { botId: info.lastInsertRowid, code, displayName });
    res.status(201).json(db.prepare("SELECT * FROM game_bot_accounts WHERE id = ?").get(info.lastInsertRowid));
  });

  // Permanently removes a bot account -- only allowed when it has never
  // placed a bet, so historical game_bets/game_wallet_ledger rows (and any
  // admin bet-history view that joins on bot_account_id) never end up
  // pointing at a deleted row. A bot with history must be disabled instead
  // (POST /bots/:id/toggle, already supported) -- that stops it from
  // placing new bets while keeping every past round's record intact, which
  // is what "soft deletion" means for this table's status column.
  router.delete("/bots/:id", (req, res) => {
    const bot = db.prepare("SELECT * FROM game_bot_accounts WHERE id = ? AND game_id = ?").get(req.params.id, gameId);
    if (!bot) return res.status(404).json({ error: "Bot account not found." });
    const betCount = db.prepare("SELECT COUNT(*) AS n FROM game_bets WHERE bot_account_id = ?").get(bot.id).n;
    if (betCount > 0) {
      return res.status(400).json({
        error: `This bot has placed ${betCount} bet(s) and can't be deleted without losing that history. Disable it instead to stop it from placing new bets.`,
      });
    }
    db.prepare("DELETE FROM game_bot_accounts WHERE id = ?").run(bot.id);
    gameConfig.audit(gameId, req.user.id, "bot_deleted", { botId: bot.id, code: bot.code });
    res.json({ ok: true });
  });

  router.get("/audit-logs", (req, res) => {
    res.json(gameConfig.auditLog(gameId, Math.min(300, Number(req.query.limit) || 100)));
  });

  router.get("/health", (req, res) => {
    const lastRound = db.prepare("SELECT created_at FROM game_rounds WHERE game_id = ? ORDER BY id DESC LIMIT 1").get(gameId);
    res.json({
      gameId,
      wsConnections: namespace ? ws.connectionCount(namespace) : 0,
      lastRoundCreatedAt: lastRound?.created_at || null,
      botAccountCount: botCodes.length,
    });
  });

  return router;
}

module.exports = { createGameAdminRouter };
