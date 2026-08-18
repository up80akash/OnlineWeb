// Number Prediction — 0-9 draw with Single/Odd/Even/Small/Big markets.
// Self-contained like every other game module: own WS connection (with
// polling fallback + reconnect), own render loop, own bet/verify calls.

(function () {
  const GAME_SLUG = "number_prediction";
  const QUICK_AMOUNTS = [5, 25, 100, 500];
  const CATEGORY_LABELS = { odd: "Odd", even: "Even", small: "Small (0-4)", big: "Big (5-9)" };
  const THEME_KEY = (window.getGameTheme && window.getGameTheme(GAME_SLUG).theme) || "futuristic";
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
  let revealTimer = null;
  let animatedRoundId = null;

  function el(id) { return view.querySelector(`#${id}`); }

  function wsUrl() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws/number-prediction?token=${encodeURIComponent(getToken() || "")}`;
  }

  function connectWs() {
    if (destroyed) return;
    try { ws = new WebSocket(wsUrl()); } catch { fallbackToPolling(); return; }
    ws.addEventListener("open", () => { usingPoll = false; stopPolling(); updateWsStatus(true); refreshState(); });
    ws.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (["ROUND_CREATED", "BETTING_CLOSED", "RESULT_REVEALED", "ROUND_COMPLETED", "BET_PLACED", "BET_SETTLED"].includes(msg.event)) {
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
    pollTimer = setInterval(refreshState, 900);
  }

  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function updateWsStatus(connected) {
    const badge = el("np-ws-status");
    if (!badge) return;
    badge.classList.toggle("connected", connected);
    badge.querySelector(".label").textContent = connected ? "Live" : "Reconnecting…";
  }

  async function refreshState() {
    if (destroyed) return;
    try { latest = await api("/games/number-prediction/state"); } catch { return; }
    if (destroyed) return;
    setBalance(latest.walletBalance);
    render();
  }

  function myBetFor(type) {
    return (latest.myBets || []).find((b) => b.betType === type);
  }

  function tileClass(type) {
    const bet = myBetFor(type);
    if (!bet) return "";
    if (bet.status === "won") return " won";
    if (bet.status === "lost") return " lost";
    return " placed";
  }

  function numberTileHtml(n) {
    const type = `single:${n}`;
    const bet = myBetFor(type);
    const reveal = latest.state.status !== "betting" && latest.state.result !== null;
    const isResult = reveal && latest.state.result === n;
    return `<button class="np-number-tile${tileClass(type)}${isResult ? " is-result" : ""}" data-bet-type="${type}" data-testid="np-tile-${type}">
      <span class="np-number">${n}</span>
      ${bet ? `<span class="np-tile-amount">${bet.betAmount}</span>` : `<span class="np-tile-payout">${latest.state.singlePayout}x</span>`}
    </button>`;
  }

  function categoryTileHtml(type) {
    const bet = myBetFor(type);
    return `<button class="np-category-tile${tileClass(type)}" data-bet-type="${type}" data-testid="np-tile-${type}">
      <span>${CATEGORY_LABELS[type]}</span>
      ${bet ? `<span class="np-tile-amount">${bet.betAmount}</span>` : `<span class="np-tile-payout">${latest.state.categoryPayout}x</span>`}
    </button>`;
  }

  function resultDisplay() {
    const s = latest.state;
    if (s.status === "betting") return `<div class="np-result-number idle">?</div>`;
    if (s.status === "revealing") return `<div class="np-result-number revealing">?</div>`;
    return `<div class="np-result-number revealed" data-testid="np-result-number">${s.result}</div>`;
  }

  function liveActivityHtml() {
    const rows = latest.liveActivity || [];
    if (!rows.length) return `<p class="hint">No bets yet this round.</p>`;
    return rows
      .map((r) => {
        const statusClass = r.status === "won" ? "won" : r.status === "lost" ? "lost" : "pending";
        const label = r.betType.startsWith("single:") ? `#${r.betType.split(":")[1]}` : CATEGORY_LABELS[r.betType] || r.betType;
        return `<div class="live-activity-row">
          <span class="la-name${r.isBot ? " is-bot" : ""}">${escapeHtml(r.playerName || "Player")}</span>
          <span>${label} · ${r.betAmount}</span>
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
        const big = bet.betType && bet.betType.startsWith("single:");
        window.AudioEngine.playSound(big ? "bigwin" : "win", { theme: THEME_KEY });
        if (themeCtl) themeCtl.celebrate(big ? "bigwin" : "win");
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
      <div class="play-arena" style="--glow: var(--neon-green);">
        <button class="back-link" id="back-to-grid" data-testid="back-to-games-btn">&larr; Back to Games</button>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h2>Number Prediction</h2>
          <span class="ws-status" id="np-ws-status"><span class="dot"></span><span class="label">Connecting…</span></span>
        </div>
        ${THEME_TAGLINE ? `<p class="theme-tagline">${escapeHtml(THEME_TAGLINE)}</p>` : ""}
        <p class="hint">Predict the 0-9 draw, or bet a category. Place as many independent bets as you like each round.</p>

        <div class="np-stage">
          ${resultDisplay()}
          <div class="aviator-status-line" id="np-status"></div>
        </div>

        <div class="np-amount-row">
          <span class="hint">Bet Amount:</span>
          ${QUICK_AMOUNTS.map((a) => `<button class="np-amount-chip${a === betAmount ? " active" : ""}" data-amount="${a}">${a}</button>`).join("")}
          <input type="number" id="np-custom-amount" min="${s.minBet}" max="${s.maxBet}" step="1" value="${betAmount}" style="width:90px;" data-testid="np-amount-input">
        </div>

        <h3 class="dash-section-title">Single Number — ${s.singlePayout}x</h3>
        <div class="np-number-grid" id="np-number-grid">${Array.from({ length: 10 }, (_, n) => numberTileHtml(n)).join("")}</div>

        <h3 class="dash-section-title">Categories — ${s.categoryPayout}x</h3>
        <div class="np-category-grid" id="np-category-grid">
          ${["odd", "even", "small", "big"].map(categoryTileHtml).join("")}
        </div>

        <div id="np-result"></div>

        <h3 class="dash-section-title">Round History</h3>
        <div class="recent-rounds" id="np-recent-rounds">
          ${(latest.recentRounds || []).map((r) => `<span class="round-chip mid">${r.number}</span>`).join("")}
        </div>

        <h3 class="dash-section-title">Live Player Activity</h3>
        <div class="live-activity" id="np-live-activity">${liveActivityHtml()}</div>

        <div class="verify-panel" id="np-verify-panel">
          <h3 style="margin-top:0;">Provably Fair Verification</h3>
          <p class="hint">The 0-9 result is derived from a committed server seed (hash shown before the draw), a client seed, and the round nonce. Once a round resolves, its server seed is revealed — verify it below.</p>
          <div class="field-row"><div class="field"><label>Server Seed</label><input type="text" id="np-verify-server-seed" placeholder="revealed after the round resolves"></div></div>
          <div class="field-row">
            <div class="field"><label>Client Seed</label><input type="text" id="np-verify-client-seed"></div>
            <div class="field"><label>Nonce</label><input type="number" id="np-verify-nonce"></div>
          </div>
          <button class="play-btn" id="np-verify-btn" data-testid="np-verify-btn">Verify</button>
          <div class="verify-result" id="np-verify-result"></div>
        </div>
      </div>
    `;

    updateStatusLine();
    wireEvents();
    updateWsStatus(!usingPoll && ws && ws.readyState === WebSocket.OPEN);

    if (s.status === "revealing" && animatedRoundId !== s.roundId) {
      animatedRoundId = s.roundId;
    }
  }

  function updateStatusLine() {
    const s = latest.state;
    const statusEl = el("np-status");
    if (!statusEl) return;
    if (s.status === "betting") {
      const secsLeft = Math.max(0, Math.ceil((new Date(s.bettingEndsAt).getTime() - Date.now()) / 1000));
      statusEl.textContent = `Betting closes in ${secsLeft}s`;
    } else if (s.status === "revealing") {
      statusEl.textContent = "Drawing the number…";
    } else {
      statusEl.textContent = `Result: ${s.result} — next round starting soon…`;
    }
  }

  function wireEvents() {
    el("back-to-grid").addEventListener("click", () => onBack());

    view.querySelectorAll("[data-amount]").forEach((btn) => {
      btn.addEventListener("click", () => {
        betAmount = Number(btn.dataset.amount);
        el("np-custom-amount").value = betAmount;
        render();
      });
    });
    const customInput = el("np-custom-amount");
    if (customInput) {
      customInput.addEventListener("input", (e) => { betAmount = parseInt(e.target.value, 10) || 0; });
    }

    view.querySelectorAll("[data-bet-type]").forEach((tile) => {
      tile.addEventListener("click", () => {
        if (tile.classList.contains("placed") || tile.classList.contains("won") || tile.classList.contains("lost")) return;
        placeBet(tile.dataset.betType);
      });
    });

    const verifyBtn = el("np-verify-btn");
    if (verifyBtn) verifyBtn.addEventListener("click", doVerify);
  }

  async function placeBet(betType) {
    if (latest.state.status !== "betting") return;
    const amount = parseInt(betAmount, 10);
    const idempotencyKey = `number_prediction:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
      const res = await api("/games/number-prediction/bet", { method: "POST", body: { betType, betAmount: amount, idempotencyKey } });
      setBalance(res.walletBalance);
      el("np-result").innerHTML = "";
      refreshState();
    } catch (err) {
      el("np-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function doVerify() {
    const serverSeed = el("np-verify-server-seed").value.trim();
    const clientSeed = el("np-verify-client-seed").value.trim();
    const nonce = parseInt(el("np-verify-nonce").value, 10);
    if (!serverSeed || !clientSeed || !Number.isInteger(nonce)) {
      el("np-verify-result").innerHTML = `<p class="form-note error">Fill in server seed, client seed and nonce.</p>`;
      return;
    }
    try {
      const res = await api("/games/number-prediction/verify", { method: "POST", body: { serverSeed, clientSeed, nonce } });
      el("np-verify-result").innerHTML = `Computed result: <b>${res.number}</b><br>Server seed hash: ${escapeHtml(res.serverSeedHash)}<br><span style="font-size:0.75rem;">${escapeHtml(res.formula)}</span>`;
    } catch (err) {
      el("np-verify-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
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
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  window.GAME_MODULES = window.GAME_MODULES || {};
  window.GAME_MODULES.number_prediction = { mount, unmount };
})();
