const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const db = require("./../db");

// One namespace per game, each isolated from the others -- a flood or crash
// in one game's room can't affect another's, since they're just separate
// Sets of sockets with independent broadcast calls.
const NAMESPACES = ["aviator", "number-prediction", "andar-bahar", "dice-roll", "coin-flip"];

const rooms = new Map(NAMESPACES.map((ns) => [ns, new Set()]));

function init(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (!url.pathname.startsWith("/ws/")) return; // not ours; let other upgrade handlers (if any) see it
    const namespace = url.pathname.slice(4);
    if (!rooms.has(namespace)) {
      socket.destroy();
      return;
    }

    // Round state broadcast on this channel is public (same data the REST
    // "state" endpoint returns), so an anonymous connection is allowed --
    // it just won't get a validated `user`. Every bet-placing action still
    // goes through the authenticated REST endpoints, never the socket, so a
    // forged/missing token here cannot place bets or move wallet funds.
    const token = url.searchParams.get("token");
    let user = null;
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        user = db.prepare("SELECT id, name, role, status FROM users WHERE id = ?").get(payload.id) || null;
        if (user && user.status === "locked") user = null;
      } catch {
        user = null;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.namespace = namespace;
      ws.user = user;
      rooms.get(namespace).add(ws);
      ws.on("close", () => rooms.get(namespace).delete(ws));
      ws.on("error", () => rooms.get(namespace).delete(ws));
    });
  });
}

function broadcast(namespace, event, data) {
  const set = rooms.get(namespace);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function connectionCount(namespace) {
  return rooms.get(namespace)?.size || 0;
}

module.exports = { init, broadcast, connectionCount, NAMESPACES };
