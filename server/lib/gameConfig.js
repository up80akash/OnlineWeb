const db = require("../db");

// Versioned per-game configuration. Reading always returns the active
// version (falling back to a game's hardcoded defaults if no admin has
// changed anything yet); writing never mutates a row in place -- it inserts
// a new version and flips is_active, so the full change history survives
// and every change is attributable to an admin (changed_by) and audited.
function getActiveConfig(gameId, defaults) {
  const row = db.prepare("SELECT * FROM game_config WHERE game_id = ? AND is_active = 1").get(gameId);
  if (!row) return { version: 0, config: { ...defaults } };
  return { version: row.version, config: { ...defaults, ...JSON.parse(row.config) } };
}

function setConfig(gameId, config, actorId) {
  const run = db.transaction(() => {
    const last = db.prepare("SELECT MAX(version) AS v FROM game_config WHERE game_id = ?").get(gameId);
    const version = (last.v || 0) + 1;
    db.prepare("UPDATE game_config SET is_active = 0 WHERE game_id = ? AND is_active = 1").run(gameId);
    db.prepare(
      "INSERT INTO game_config (game_id, version, config, is_active, changed_by) VALUES (?, ?, ?, 1, ?)"
    ).run(gameId, version, JSON.stringify(config), actorId);
    db.prepare(
      "INSERT INTO game_audit_logs (game_id, actor_id, action, details) VALUES (?, ?, 'config_updated', ?)"
    ).run(gameId, actorId, JSON.stringify({ version, config }));
    return version;
  });
  return run();
}

function configHistory(gameId, limit = 20) {
  return db.prepare("SELECT * FROM game_config WHERE game_id = ? ORDER BY version DESC LIMIT ?").all(gameId, limit);
}

function audit(gameId, actorId, action, details) {
  db.prepare("INSERT INTO game_audit_logs (game_id, actor_id, action, details) VALUES (?, ?, ?, ?)").run(
    gameId,
    actorId ?? null,
    action,
    details ? JSON.stringify(details) : null
  );
}

function auditLog(gameId, limit = 100) {
  return db.prepare(
    `SELECT a.*, u.name AS actor_name FROM game_audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.game_id = ? ORDER BY a.id DESC LIMIT ?`
  ).all(gameId, limit);
}

module.exports = { getActiveConfig, setConfig, configHistory, audit, auditLog };
