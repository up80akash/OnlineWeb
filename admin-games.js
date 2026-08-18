// Admin "Games" panel: per-game Dashboard/Rounds/Bets/Settlements/
// Configuration/Provably Fair/Bots/Audit Logs/Health, backed by the shared
// admin API surface every game module mounts (server/lib/gameAdmin.js).
// This file only renders and dispatches -- it contains no game logic and
// cannot change a round's outcome, only configuration going forward.

const GAMES_ADMIN_LIST = [
  { slug: "aviator", label: "Aviator" },
  { slug: "number-prediction", label: "Number Prediction" },
  { slug: "andar-bahar", label: "Andar Bahar" },
  { slug: "dice-roll", label: "Dice Roll" },
  { slug: "coin-flip", label: "Coin Flip" },
];

const GAMES_ADMIN_SUBTABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "rounds", label: "Rounds" },
  { key: "bets", label: "Bets" },
  { key: "settlements", label: "Settlements" },
  { key: "config", label: "Configuration" },
  { key: "provably-fair", label: "Provably Fair" },
  { key: "bots", label: "Bots" },
  { key: "audit-logs", label: "Audit Logs" },
  { key: "health", label: "Health" },
];

let gamesAdminSelectedGame = null;
let gamesAdminSelectedSubtab = "dashboard";

function gamesAdminTable(headers, rows, emptyMsg) {
  if (!rows.length) return `<p class="hint">${emptyMsg}</p>`;
  return `<div class="table-wrap"><table class="dash-table"><thead><tr>${headers
    .map((h) => `<th>${h}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function gamesAdminStatusBadge(status) {
  const cls = ["won", "cashed", "active", "resolved"].includes(status) ? "active" : status === "lost" ? "locked" : "pending";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

function initGamesAdminPanel() {
  renderGamesAdminSelector();
}

function renderGamesAdminSelector() {
  const el = document.getElementById("games-admin-selector");
  if (!el) return;
  el.innerHTML = `
    <button class="games-admin-chip${!gamesAdminSelectedGame ? " active" : ""}" data-game="">All Games</button>
    ${GAMES_ADMIN_LIST.map((g) => `<button class="games-admin-chip${gamesAdminSelectedGame === g.slug ? " active" : ""}" data-game="${g.slug}">${g.label}</button>`).join("")}
  `;
  el.querySelectorAll("[data-game]").forEach((btn) => {
    btn.addEventListener("click", () => {
      gamesAdminSelectedGame = btn.dataset.game || null;
      gamesAdminSelectedSubtab = "dashboard";
      renderGamesAdminSelector();
      renderGamesAdminSubtabs();
      renderGamesAdminContent();
    });
  });
  renderGamesAdminSubtabs();
  renderGamesAdminContent();
}

function renderGamesAdminSubtabs() {
  const el = document.getElementById("games-admin-subtabs");
  if (!el) return;
  if (!gamesAdminSelectedGame) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = GAMES_ADMIN_SUBTABS.map(
    (t) => `<button class="games-admin-subtab${gamesAdminSelectedSubtab === t.key ? " active" : ""}" data-tab="${t.key}">${t.label}</button>`
  ).join("");
  el.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      gamesAdminSelectedSubtab = btn.dataset.tab;
      renderGamesAdminSubtabs();
      renderGamesAdminContent();
    });
  });
}

async function renderGamesAdminContent() {
  const el = document.getElementById("games-admin-content");
  if (!el) return;
  el.innerHTML = `<p class="hint">Loading…</p>`;
  try {
    if (!gamesAdminSelectedGame) {
      const rows = await api("/admin/games/history");
      el.innerHTML = gamesAdminTable(
        ["Player", "Game", "Bet", "Result", "Prize", "Time"],
        rows.map((r) => [
          escapeHtml(r.player),
          escapeHtml(String(r.gameSlug).replace(/_/g, " ")),
          r.betAmount,
          gamesAdminStatusBadge(r.result === "win" ? "won" : r.result === "loss" ? "lost" : "pending"),
          r.prize,
          formatDate(r.createdAt),
        ]),
        "No game plays yet."
      );
      return;
    }
    const renderers = {
      dashboard: renderGamesAdminDashboard,
      rounds: renderGamesAdminRounds,
      bets: renderGamesAdminBets,
      settlements: renderGamesAdminSettlements,
      config: renderGamesAdminConfig,
      "provably-fair": renderGamesAdminProvablyFair,
      bots: renderGamesAdminBots,
      "audit-logs": renderGamesAdminAuditLogs,
      health: renderGamesAdminHealth,
    };
    await renderers[gamesAdminSelectedSubtab]();
  } catch (err) {
    el.innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
  }
}

async function renderGamesAdminDashboard() {
  const d = await api(`/admin/games/${gamesAdminSelectedGame}/dashboard`);
  document.getElementById("games-admin-content").innerHTML = `
    <div class="dash-grid">
      <div class="dash-card"><h3>Active Round</h3><p class="hint">${d.activeRound ? `#${d.activeRound.roundNumber} · ${escapeHtml(d.activeRound.status)}` : "—"}</p></div>
      <div class="dash-card"><h3>Bets (24h)</h3><div class="stat">${d.last24h.betCount}</div></div>
      <div class="dash-card"><h3>Volume (24h)</h3><div class="stat">${d.last24h.volume}</div></div>
      <div class="dash-card"><h3>Payouts (24h)</h3><div class="stat">${d.last24h.payouts}</div></div>
      <div class="dash-card"><h3>Unique Players (24h)</h3><div class="stat">${d.last24h.uniquePlayers}</div></div>
      <div class="dash-card"><h3>WebSocket Connections</h3><div class="stat">${d.wsConnections}</div></div>
    </div>`;
}

async function renderGamesAdminRounds() {
  const rows = await api(`/admin/games/${gamesAdminSelectedGame}/rounds?limit=50`);
  document.getElementById("games-admin-content").innerHTML = gamesAdminTable(
    ["#", "Status", "Server Seed Hash", "Server Seed (revealed)", "Nonce", "Result", "Created"],
    rows.map((r) => [
      r.roundNumber,
      gamesAdminStatusBadge(r.status),
      `<span class="mono-cell">${escapeHtml(r.serverSeedHash)}</span>`,
      r.serverSeed ? `<span class="mono-cell">${escapeHtml(r.serverSeed)}</span>` : "—",
      r.nonce,
      r.result ? `<span class="mono-cell">${escapeHtml(JSON.stringify(r.result))}</span>` : "—",
      formatDate(r.createdAt),
    ]),
    "No rounds yet."
  );
}

async function renderGamesAdminBets() {
  const rows = await api(`/admin/games/${gamesAdminSelectedGame}/bets?limit=100`);
  document.getElementById("games-admin-content").innerHTML = gamesAdminTable(
    ["Player", "Type", "Amount", "Status", "Prize", "Time"],
    rows.map((r) => [
      `${escapeHtml(r.playerName)}${r.isBot ? ` <span class="hint">(bot)</span>` : ""}`,
      escapeHtml(r.bet_type),
      r.bet_amount,
      gamesAdminStatusBadge(r.status),
      r.settled_amount,
      formatDate(r.created_at),
    ]),
    "No bets yet."
  );
}

async function renderGamesAdminSettlements() {
  const rows = await api(`/admin/games/${gamesAdminSelectedGame}/settlements?limit=100`);
  document.getElementById("games-admin-content").innerHTML = gamesAdminTable(
    ["Player", "Type", "Amount", "Status", "Settled", "Time"],
    rows.map((r) => [
      `${escapeHtml(r.playerName)}${r.isBot ? ` <span class="hint">(bot)</span>` : ""}`,
      escapeHtml(r.bet_type),
      r.bet_amount,
      gamesAdminStatusBadge(r.status),
      r.settled_amount,
      formatDate(r.settled_at),
    ]),
    "No settlements yet."
  );
}

async function renderGamesAdminConfig() {
  const data = await api(`/admin/games/${gamesAdminSelectedGame}/config`);
  const cfg = data.active.config;
  const fields = Object.entries(cfg)
    .map(
      ([k, v]) => `
    <div class="field">
      <label for="cfg-${k}">${escapeHtml(k)}</label>
      <input type="number" step="any" id="cfg-${k}" value="${v}">
    </div>`
    )
    .join("");
  document.getElementById("games-admin-content").innerHTML = `
    <p class="hint">Active version: ${data.active.version}. Changes are versioned and audited -- nothing here can alter a round already in progress or already resolved.</p>
    <form id="games-config-form" class="inline-form">${fields}<button type="submit" class="inline-btn">Save Configuration</button></form>
    <p class="form-note" id="games-config-note"></p>
    <h3 class="dash-section-title">Version History</h3>
    ${gamesAdminTable(
      ["Version", "Changed By", "Config", "Date"],
      data.history.map((h) => [h.version, h.changed_by ?? "—", `<span class="mono-cell">${escapeHtml(h.config)}</span>`, formatDate(h.created_at)]),
      "No changes yet."
    )}
  `;
  document.getElementById("games-config-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const patch = {};
    for (const k of Object.keys(cfg)) patch[k] = Number(document.getElementById(`cfg-${k}`).value);
    try {
      await api(`/admin/games/${gamesAdminSelectedGame}/config`, { method: "POST", body: { config: patch } });
      setNote("games-config-note", "Configuration saved as a new version.", "success");
      renderGamesAdminConfig();
    } catch (err) {
      setNote("games-config-note", err.message, "error");
    }
  });
}

async function renderGamesAdminProvablyFair() {
  const rows = await api(`/admin/games/${gamesAdminSelectedGame}/provably-fair?limit=50`);
  document.getElementById("games-admin-content").innerHTML = gamesAdminTable(
    ["#", "Status", "Server Seed Hash", "Server Seed", "Client Seed", "Nonce", "Result"],
    rows.map((r) => [
      r.roundNumber,
      escapeHtml(r.status),
      `<span class="mono-cell">${escapeHtml(r.serverSeedHash)}</span>`,
      r.serverSeed ? `<span class="mono-cell">${escapeHtml(r.serverSeed)}</span>` : "—",
      `<span class="mono-cell">${escapeHtml(r.clientSeed)}</span>`,
      r.nonce,
      r.result ? `<span class="mono-cell">${escapeHtml(JSON.stringify(r.result))}</span>` : "—",
    ]),
    "No rounds yet."
  );
}

async function renderGamesAdminBots() {
  const data = await api(`/admin/games/${gamesAdminSelectedGame}/bots`);
  const accountsHtml = gamesAdminTable(
    ["Code", "Name", "Status", "Actions"],
    data.accounts.map((b) => [
      escapeHtml(b.code),
      escapeHtml(b.display_name),
      gamesAdminStatusBadge(b.status),
      `<button class="inline-btn ghost" data-toggle-bot="${b.id}">${b.status === "active" ? "Disable" : "Enable"}</button>
       <button class="inline-btn ghost" data-delete-bot="${b.id}">Delete</button>`,
    ]),
    "No bot accounts."
  );
  const betsHtml = gamesAdminTable(
    ["Bot", "Round", "Amount", "Status", "Settled", "Time"],
    data.recentBets.map((b) => [escapeHtml(b.botCode), b.roundId, b.betAmount, gamesAdminStatusBadge(b.status), b.settledAmount, formatDate(b.createdAt)]),
    "No bot bets yet."
  );
  document.getElementById("games-admin-content").innerHTML = `
    <p class="hint">Bots place bets for live-activity atmosphere only. They have no wallet, cannot see results before they're revealed, and cannot affect outcomes -- disabling one here only stops it from placing new bets. Deleting only works for a bot that has never placed a bet; once it has history, disable it instead so past rounds stay intact.</p>
    <form id="games-bot-create-form" class="inline-form">
      <div class="field">
        <label for="bot-create-code">Bot Code</label>
        <input type="text" id="bot-create-code" placeholder="e.g. AVIATOR_BOT_006" maxlength="40" required>
      </div>
      <div class="field" style="flex:1; min-width:200px;">
        <label for="bot-create-name">Display Name</label>
        <input type="text" id="bot-create-name" placeholder="e.g. Player2106" maxlength="60" required>
      </div>
      <button type="submit" class="inline-btn">Create Bot</button>
      <p class="form-note" id="games-bot-create-note"></p>
    </form>
    <h3 class="dash-section-title" style="margin-top:0;">Bot Accounts</h3>${accountsHtml}
    <h3 class="dash-section-title">Recent Bot Bets</h3>${betsHtml}
  `;
  document.querySelectorAll("[data-toggle-bot]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/admin/games/${gamesAdminSelectedGame}/bots/${btn.dataset.toggleBot}/toggle`, { method: "POST" });
      renderGamesAdminBots();
    });
  });
  document.querySelectorAll("[data-delete-bot]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Permanently delete this bot account? This only works if it has no bet history.")) return;
      btn.disabled = true;
      try {
        await api(`/admin/games/${gamesAdminSelectedGame}/bots/${btn.dataset.deleteBot}`, { method: "DELETE" });
        renderGamesAdminBots();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
  const createForm = document.getElementById("games-bot-create-form");
  let creatingBot = false;
  createForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (creatingBot) return;
    const code = document.getElementById("bot-create-code").value.trim();
    const displayName = document.getElementById("bot-create-name").value.trim();
    creatingBot = true;
    const submitBtn = createForm.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      await api(`/admin/games/${gamesAdminSelectedGame}/bots`, { method: "POST", body: { code, displayName } });
      renderGamesAdminBots();
    } catch (err) {
      setNote("games-bot-create-note", err.message, "error");
    } finally {
      creatingBot = false;
      if (submitBtn.isConnected) submitBtn.disabled = false;
    }
  });
}

async function renderGamesAdminAuditLogs() {
  const rows = await api(`/admin/games/${gamesAdminSelectedGame}/audit-logs?limit=150`);
  document.getElementById("games-admin-content").innerHTML = gamesAdminTable(
    ["Action", "Actor", "Details", "Time"],
    rows.map((r) => [escapeHtml(r.action), escapeHtml(r.actor_name || "system"), `<span class="mono-cell">${escapeHtml(r.details || "—")}</span>`, formatDate(r.created_at)]),
    "No audit log entries yet."
  );
}

async function renderGamesAdminHealth() {
  const h = await api(`/admin/games/${gamesAdminSelectedGame}/health`);
  document.getElementById("games-admin-content").innerHTML = `
    <div class="dash-grid">
      <div class="dash-card"><h3>WebSocket Connections</h3><div class="stat">${h.wsConnections}</div></div>
      <div class="dash-card"><h3>Last Round Created</h3><p class="hint">${h.lastRoundCreatedAt ? formatDate(h.lastRoundCreatedAt) : "—"}</p></div>
      <div class="dash-card"><h3>Bot Accounts</h3><div class="stat">${h.botAccountCount}</div></div>
    </div>`;
}

window.initGamesAdminPanel = initGamesAdminPanel;
