// Dice Roll — six-sided die with Exact/Low/High/Odd/Even markets.
// Self-contained module: own WS connection (with polling fallback +
// reconnect), own render loop, own bet/verify calls.

(function () {
  const GAME_SLUG = "dice_roll";
  const QUICK_AMOUNTS = [5, 25, 100, 500];
  const CATEGORY_LABELS = { low: "Low (1-3)", high: "High (4-6)", odd: "Odd", even: "Even" };
  const DIE_FACES = { 1: "⚀", 2: "⚁", 3: "⚂", 4: "⚃", 5: "⚄", 6: "⚅" };
  const THEME_KEY = (window.getGameTheme && window.getGameTheme(GAME_SLUG).theme) || "desert";
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
    return `${proto}//${window.location.host}/ws/dice-roll?token=${encodeURIComponent(getToken() || "")}`;
  }

  function connectWs() {
    if (destroyed) return;
    try { ws = new WebSocket(wsUrl()); } catch { fallbackToPolling(); return; }
    ws.addEventListener("open", () => { usingPoll = false; stopPolling(); updateWsStatus(true); refreshState(); });
    ws.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (["ROUND_CREATED", "BETTING_CLOSED", "DICE_ROLLING", "DICE_RESULT", "ROUND_COMPLETED", "BET_PLACED", "BET_SETTLED"].includes(msg.event)) {
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
    const badge = el("dr-ws-status");
    if (!badge) return;
    badge.classList.toggle("connected", connected);
    badge.querySelector(".label").textContent = connected ? "Live" : "Reconnecting…";
  }

  async function refreshState() {
    if (destroyed) return;
    try { latest = await api("/games/dice-roll/state"); } catch { return; }
    if (destroyed) return;
    setBalance(latest.walletBalance);
    render();
  }

  function myBetFor(type) { return (latest.myBets || []).find((b) => b.betType === type); }

  function tileClass(type) {
    const bet = myBetFor(type);
    if (!bet) return "";
    if (bet.status === "won") return " won";
    if (bet.status === "lost") return " lost";
    return " placed";
  }

  function exactTileHtml(n) {
    const type = `exact:${n}`;
    const bet = myBetFor(type);
    return `<button class="np-number-tile${tileClass(type)}" data-bet-type="${type}" data-testid="dr-tile-${type}">
      <span class="np-number">${DIE_FACES[n]}</span>
      ${bet ? `<span class="np-tile-amount">${bet.betAmount}</span>` : `<span class="np-tile-payout">${latest.state.exactPayout}x</span>`}
    </button>`;
  }

  function categoryTileHtml(type) {
    const bet = myBetFor(type);
    return `<button class="np-category-tile${tileClass(type)}" data-bet-type="${type}" data-testid="dr-tile-${type}">
      <span>${CATEGORY_LABELS[type]}</span>
      ${bet ? `<span class="np-tile-amount">${bet.betAmount}</span>` : `<span class="np-tile-payout">${latest.state.categoryPayout}x</span>`}
    </button>`;
  }

  function diceDisplay() {
    const s = latest.state;
    if (s.status === "betting") return `<div class="dr-die idle">🎲</div>`;
    if (s.status === "rolling") return `<div class="dr-die rolling">🎲</div>`;
    return `<div class="dr-die revealed" data-testid="dr-result-face">${DIE_FACES[s.result]}</div>`;
  }

  function liveActivityHtml() {
    const rows = latest.liveActivity || [];
    if (!rows.length) return `<p class="hint">No bets yet this round.</p>`;
    return rows
      .map((r) => {
        const statusClass = r.status === "won" ? "won" : r.status === "lost" ? "lost" : "pending";
        const label = r.betType.startsWith("exact:") ? `⚁${r.betType.split(":")[1]}` : CATEGORY_LABELS[r.betType] || r.betType;
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
        const big = bet.betType && bet.betType.startsWith("exact:");
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
      <div class="play-arena" style="--glow: var(--neon-cyan);">
        <button class="back-link" id="back-to-grid" data-testid="back-to-games-btn">&larr; Back to Games</button>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h2>Dice Roll</h2>
          <span class="ws-status" id="dr-ws-status"><span class="dot"></span><span class="label">Connecting…</span></span>
        </div>
        ${THEME_TAGLINE ? `<p class="theme-tagline">${escapeHtml(THEME_TAGLINE)}</p>` : ""}
        <p class="hint">Bet the exact face, or a category. Place as many independent bets as you like each round.</p>

        <div class="np-stage">
          ${diceDisplay()}
          <div class="aviator-status-line" id="dr-status"></div>
        </div>

        <div class="np-amount-row">
          <span class="hint">Bet Amount:</span>
          ${QUICK_AMOUNTS.map((a) => `<button class="np-amount-chip${a === betAmount ? " active" : ""}" data-amount="${a}">${a}</button>`).join("")}
          <input type="number" id="dr-custom-amount" min="${s.minBet}" max="${s.maxBet}" step="1" value="${betAmount}" style="width:90px;" data-testid="dr-amount-input">
        </div>

        <h3 class="dash-section-title">Exact Number — ${s.exactPayout}x</h3>
        <div class="np-number-grid" id="dr-number-grid" style="grid-template-columns: repeat(6, 1fr);">${Array.from({ length: 6 }, (_, i) => exactTileHtml(i + 1)).join("")}</div>

        <h3 class="dash-section-title">Categories — ${s.categoryPayout}x</h3>
        <div class="np-category-grid" id="dr-category-grid">
          ${["low", "high", "odd", "even"].map(categoryTileHtml).join("")}
        </div>

        <div id="dr-result"></div>

        <h3 class="dash-section-title">Round History</h3>
        <div class="recent-rounds" id="dr-recent-rounds">
          ${(latest.recentRounds || []).map((r) => `<span class="round-chip mid">${DIE_FACES[r.face]}</span>`).join("")}
        </div>

        <h3 class="dash-section-title">Live Player Activity</h3>
        <div class="live-activity" id="dr-live-activity">${liveActivityHtml()}</div>

        <div class="verify-panel" id="dr-verify-panel">
          <h3 style="margin-top:0;">Provably Fair Verification</h3>
          <p class="hint">The die face is derived from a committed server seed (hash shown before the roll), a client seed, and the round nonce. Once a round resolves, its server seed is revealed — verify it below.</p>
          <div class="field-row"><div class="field"><label>Server Seed</label><input type="text" id="dr-verify-server-seed" placeholder="revealed after the round resolves"></div></div>
          <div class="field-row">
            <div class="field"><label>Client Seed</label><input type="text" id="dr-verify-client-seed"></div>
            <div class="field"><label>Nonce</label><input type="number" id="dr-verify-nonce"></div>
          </div>
          <button class="play-btn" id="dr-verify-btn" data-testid="dr-verify-btn">Verify</button>
          <div class="verify-result" id="dr-verify-result"></div>
        </div>
      </div>
    `;

    updateStatusLine();
    wireEvents();
    updateWsStatus(!usingPoll && ws && ws.readyState === WebSocket.OPEN);
  }

  function updateStatusLine() {
    const s = latest.state;
    const statusEl = el("dr-status");
    if (!statusEl) return;
    if (s.status === "betting") {
      const secsLeft = Math.max(0, Math.ceil((new Date(s.bettingEndsAt).getTime() - Date.now()) / 1000));
      statusEl.textContent = `Betting closes in ${secsLeft}s`;
    } else if (s.status === "rolling") {
      statusEl.textContent = "Rolling…";
    } else {
      statusEl.textContent = `Rolled ${s.result} — next round starting soon…`;
    }
  }

  function wireEvents() {
    el("back-to-grid").addEventListener("click", () => onBack());
    view.querySelectorAll("[data-amount]").forEach((btn) => {
      btn.addEventListener("click", () => {
        betAmount = Number(btn.dataset.amount);
        el("dr-custom-amount").value = betAmount;
        render();
      });
    });
    const customInput = el("dr-custom-amount");
    if (customInput) customInput.addEventListener("input", (e) => { betAmount = parseInt(e.target.value, 10) || 0; });

    view.querySelectorAll("[data-bet-type]").forEach((tile) => {
      tile.addEventListener("click", () => {
        if (tile.classList.contains("placed") || tile.classList.contains("won") || tile.classList.contains("lost")) return;
        placeBet(tile.dataset.betType);
      });
    });

    const verifyBtn = el("dr-verify-btn");
    if (verifyBtn) verifyBtn.addEventListener("click", doVerify);
  }

  async function placeBet(betType) {
    if (latest.state.status !== "betting") return;
    const amount = parseInt(betAmount, 10);
    const idempotencyKey = `dice_roll:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
      const res = await api("/games/dice-roll/bet", { method: "POST", body: { betType, betAmount: amount, idempotencyKey } });
      setBalance(res.walletBalance);
      el("dr-result").innerHTML = "";
      refreshState();
    } catch (err) {
      el("dr-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function doVerify() {
    const serverSeed = el("dr-verify-server-seed").value.trim();
    const clientSeed = el("dr-verify-client-seed").value.trim();
    const nonce = parseInt(el("dr-verify-nonce").value, 10);
    if (!serverSeed || !clientSeed || !Number.isInteger(nonce)) {
      el("dr-verify-result").innerHTML = `<p class="form-note error">Fill in server seed, client seed and nonce.</p>`;
      return;
    }
    try {
      const res = await api("/games/dice-roll/verify", { method: "POST", body: { serverSeed, clientSeed, nonce } });
      el("dr-verify-result").innerHTML = `Computed face: <b>${res.face}</b><br>Server seed hash: ${escapeHtml(res.serverSeedHash)}<br><span style="font-size:0.75rem;">${escapeHtml(res.formula)}</span>`;
    } catch (err) {
      el("dr-verify-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
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
  window.GAME_MODULES.dice_roll = { mount, unmount };
})();
