// Coin Flip — Heads or Tails. Self-contained module: own WS connection
// (with polling fallback + reconnect), own render loop, own bet/verify
// calls. The animation only ever displays the server-generated result,
// never a client-guessed outcome.

(function () {
  const GAME_SLUG = "coin_flip";
  const QUICK_AMOUNTS = [5, 25, 100, 500];
  const THEME_KEY = (window.getGameTheme && window.getGameTheme(GAME_SLUG).theme) || "treasure";
  const THEME_TAGLINE = (window.getGameTheme && window.getGameTheme(GAME_SLUG).tagline) || "";

  let themeCtl = null;
  let announcedBets = new Set();
  let lastRoundStatus = null;
  let lastCountdownSec = null;

  let ws = null;
  let wsReconnectTimer = null;
  let pollTimer = null;
  let usingPoll = false;
  let destroyed = false;

  let view = null;
  let game = null;
  let onBack = null;
  let latest = null;
  let betAmount = 25;

  function el(id) { return view.querySelector(`#${id}`); }

  function wsUrl() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws/coin-flip?token=${encodeURIComponent(getToken() || "")}`;
  }

  function connectWs() {
    if (destroyed) return;
    try { ws = new WebSocket(wsUrl()); } catch { fallbackToPolling(); return; }
    ws.addEventListener("open", () => { usingPoll = false; stopPolling(); updateWsStatus(true); refreshState(); });
    ws.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (["ROUND_CREATED", "BETTING_CLOSED", "COIN_FLIPPING", "COIN_RESULT", "ROUND_COMPLETED", "BET_PLACED", "BET_SETTLED"].includes(msg.event)) {
        refreshState();
      }
    });
    ws.addEventListener("close", () => {
      if (destroyed) return;
      updateWsStatus(false);
      fallbackToPolling();
      wsReconnectTimer = setTimeout(connectWs, 2000);
    });
    ws.addEventListener("error", () => { try { ws.close(); } catch {} });
  }

  function fallbackToPolling() {
    if (usingPoll || destroyed) return;
    usingPoll = true;
    refreshState();
    pollTimer = setInterval(refreshState, 800);
  }

  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function updateWsStatus(connected) {
    const badge = el("cf-ws-status");
    if (!badge) return;
    badge.classList.toggle("connected", connected);
    badge.querySelector(".label").textContent = connected ? "Live" : "Reconnecting…";
  }

  async function refreshState() {
    if (destroyed) return;
    try { latest = await api("/games/coin-flip/state"); } catch { return; }
    if (destroyed) return;
    setBalance(latest.walletBalance);
    render();
  }

  function myBetFor(side) { return (latest.myBets || []).find((b) => b.side === side); }

  function coinDisplay() {
    const s = latest.state;
    if (s.status === "betting") return `<div class="cf-coin idle">?</div>`;
    if (s.status === "flipping") return `<div class="cf-coin flipping">?</div>`;
    return `<div class="cf-coin revealed" data-testid="cf-result-side">${s.result === "heads" ? "H" : "T"}</div>`;
  }

  function sideCardHtml(side) {
    const bet = myBetFor(side);
    const won = latest.state.status === "completed" && latest.state.result === side;
    return `
      <div class="ab-side-column${won ? " winner" : ""}">
        <div class="ab-side-header">
          <h4>${side.toUpperCase()}</h4>
          <span class="ab-payout">${latest.state.payoutMultiplier}x</span>
        </div>
        ${
          bet
            ? `<div class="pending-chip">Bet: ${bet.betAmount} tokens${bet.status === "won" ? " · WON +" + bet.prize : bet.status === "lost" ? " · lost" : ""}</div>`
            : `<div class="ab-bet-row">
                <input type="number" min="${latest.state.minBet}" max="${latest.state.maxBet}" value="${betAmount}" data-cf-amount="${side}" style="width:80px;">
                <button class="play-btn" data-cf-bet="${side}" data-testid="cf-bet-btn-${side}" ${latest.state.status !== "betting" ? "disabled" : ""}>Bet ${side === "heads" ? "Heads" : "Tails"}</button>
              </div>`
        }
      </div>`;
  }

  function liveActivityHtml() {
    const rows = latest.liveActivity || [];
    if (!rows.length) return `<p class="hint">No bets yet this round.</p>`;
    return rows
      .map((r) => {
        const statusClass = r.status === "won" ? "won" : r.status === "lost" ? "lost" : "pending";
        return `<div class="live-activity-row">
          <span class="la-name${r.isBot ? " is-bot" : ""}">${escapeHtml(r.playerName || "Player")}</span>
          <span>${r.betType.toUpperCase()} · ${r.betAmount}</span>
          <span class="la-status ${statusClass}">${r.status}</span>
        </div>`;
      })
      .join("");
  }

  function handleRoundAudio(s) {
    if (!window.AudioEngine) return;
    if (s.status !== lastRoundStatus) {
      if (s.status === "betting") {
        window.AudioEngine.playSound("start", { theme: THEME_KEY });
        lastCountdownSec = null;
      }
      lastRoundStatus = s.status;
    }
    if (s.status === "betting") {
      const secsLeft = Math.max(0, Math.ceil((new Date(s.bettingEndsAt).getTime() - Date.now()) / 1000));
      if (secsLeft > 0 && secsLeft <= 3 && secsLeft !== lastCountdownSec) {
        lastCountdownSec = secsLeft;
        window.AudioEngine.playSound("countdown", { theme: THEME_KEY });
      }
    }
  }

  function announceBetOutcomes(myBets) {
    if (!window.AudioEngine) return;
    (myBets || []).forEach((bet) => {
      if (!bet || bet.id === undefined) return;
      const key = `${bet.id}:${bet.status}`;
      if (announcedBets.has(key)) return;
      announcedBets.add(key);
      if (bet.status === "pending") {
        window.AudioEngine.playSound("bet", { theme: THEME_KEY });
      } else if (bet.status === "won") {
        window.AudioEngine.playSound("win", { theme: THEME_KEY });
        if (themeCtl) themeCtl.celebrate("win");
      } else if (bet.status === "lost") {
        window.AudioEngine.playSound("lose", { theme: THEME_KEY });
        if (themeCtl) themeCtl.celebrate("lose");
      }
    });
  }

  function render() {
    if (!latest) return;
    const s = latest.state;
    handleRoundAudio(s);
    announceBetOutcomes(latest.myBets);

    view.innerHTML = `
      <div class="play-arena" style="--glow: var(--neon-amber);">
        <button class="back-link" id="back-to-grid" data-testid="back-to-games-btn">&larr; Back to Games</button>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h2>Coin Flip</h2>
          <span class="ws-status" id="cf-ws-status"><span class="dot"></span><span class="label">Connecting…</span></span>
        </div>
        ${THEME_TAGLINE ? `<p class="theme-tagline">${escapeHtml(THEME_TAGLINE)}</p>` : ""}
        <p class="hint">Call it in the air — Heads or Tails.</p>

        <div class="np-stage">
          ${coinDisplay()}
          <div class="aviator-status-line" id="cf-status"></div>
        </div>

        <div class="ab-table">${sideCardHtml("heads")}${sideCardHtml("tails")}</div>

        <div id="cf-result"></div>

        <h3 class="dash-section-title">Round History</h3>
        <div class="recent-rounds" id="cf-recent-rounds">
          ${(latest.recentRounds || []).map((r) => `<span class="round-chip ${r.side === "heads" ? "mid" : "high"}">${r.side === "heads" ? "H" : "T"}</span>`).join("")}
        </div>

        <h3 class="dash-section-title">Live Player Activity</h3>
        <div class="live-activity" id="cf-live-activity">${liveActivityHtml()}</div>

        <div class="verify-panel" id="cf-verify-panel">
          <h3 style="margin-top:0;">Provably Fair Verification</h3>
          <p class="hint">The coin face is derived from a committed server seed (hash shown before the flip), a client seed, and the round nonce. Once a round resolves, its server seed is revealed — verify it below.</p>
          <div class="field-row"><div class="field"><label>Server Seed</label><input type="text" id="cf-verify-server-seed" placeholder="revealed after the round resolves"></div></div>
          <div class="field-row">
            <div class="field"><label>Client Seed</label><input type="text" id="cf-verify-client-seed"></div>
            <div class="field"><label>Nonce</label><input type="number" id="cf-verify-nonce"></div>
          </div>
          <button class="play-btn" id="cf-verify-btn" data-testid="cf-verify-btn">Verify</button>
          <div class="verify-result" id="cf-verify-result"></div>
        </div>
      </div>
    `;

    updateStatusLine();
    wireEvents();
    updateWsStatus(!usingPoll && ws && ws.readyState === WebSocket.OPEN);
  }

  function updateStatusLine() {
    const s = latest.state;
    const statusEl = el("cf-status");
    if (!statusEl) return;
    if (s.status === "betting") {
      const secsLeft = Math.max(0, Math.ceil((new Date(s.bettingEndsAt).getTime() - Date.now()) / 1000));
      statusEl.textContent = `Betting closes in ${secsLeft}s`;
    } else if (s.status === "flipping") {
      statusEl.textContent = "Flipping…";
    } else {
      statusEl.textContent = `${s.result === "heads" ? "Heads" : "Tails"} — next round starting soon…`;
    }
  }

  function wireEvents() {
    el("back-to-grid").addEventListener("click", () => onBack());
    view.querySelectorAll("[data-cf-amount]").forEach((input) => {
      input.addEventListener("input", (e) => { betAmount = parseInt(e.target.value, 10) || 0; });
    });
    view.querySelectorAll("[data-cf-bet]").forEach((btn) => {
      btn.addEventListener("click", () => placeBet(btn.dataset.cfBet));
    });
    const verifyBtn = el("cf-verify-btn");
    if (verifyBtn) verifyBtn.addEventListener("click", doVerify);
  }

  async function placeBet(side) {
    const amount = parseInt(betAmount, 10);
    const idempotencyKey = `coin_flip:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
      const res = await api("/games/coin-flip/bet", { method: "POST", body: { side, betAmount: amount, idempotencyKey } });
      setBalance(res.walletBalance);
      el("cf-result").innerHTML = "";
      refreshState();
    } catch (err) {
      el("cf-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function doVerify() {
    const serverSeed = el("cf-verify-server-seed").value.trim();
    const clientSeed = el("cf-verify-client-seed").value.trim();
    const nonce = parseInt(el("cf-verify-nonce").value, 10);
    if (!serverSeed || !clientSeed || !Number.isInteger(nonce)) {
      el("cf-verify-result").innerHTML = `<p class="form-note error">Fill in server seed, client seed and nonce.</p>`;
      return;
    }
    try {
      const res = await api("/games/coin-flip/verify", { method: "POST", body: { serverSeed, clientSeed, nonce } });
      el("cf-verify-result").innerHTML = `Computed side: <b>${res.side}</b><br>Server seed hash: ${escapeHtml(res.serverSeedHash)}<br><span style="font-size:0.75rem;">${escapeHtml(res.formula)}</span>`;
    } catch (err) {
      el("cf-verify-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
    }
  }

  function mount(_view, _game, _onBack, _theme) {
    view = _view;
    game = _game;
    onBack = _onBack;
    themeCtl = _theme || null;
    destroyed = false;
    announcedBets = new Set();
    lastRoundStatus = null;
    lastCountdownSec = null;
    connectWs();
    refreshState();
  }

  function unmount() {
    destroyed = true;
    stopPolling();
    themeCtl = null;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  window.GAME_MODULES = window.GAME_MODULES || {};
  window.GAME_MODULES.coin_flip = { mount, unmount };
})();
