// Aviator — crash game module. Fully self-contained: its own render loop,
// its own WebSocket connection (with polling fallback + reconnect), its own
// bet/cashout/verify calls. Nothing here is shared with any other game
// except the generic api()/escapeHtml()/setBalance() dashboard helpers and
// the CSS building blocks (.play-arena/.play-btn/...) common to every game.

(function () {
  const GAME_SLUG = "aviator";
  const QUICK_AMOUNTS = [10, 50, 100, 500];
  const THEME_KEY = (window.getGameTheme && window.getGameTheme(GAME_SLUG).theme) || "sky";
  const THEME_TAGLINE = (window.getGameTheme && window.getGameTheme(GAME_SLUG).tagline) || "";
  const BIG_WIN_MULTIPLIER = 5;

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

  let latest = null; // last /state response
  let localMultiplier = 1;
  let animFrame = null;
  let flyingSince = null;
  let growthK = 0.07;
  let panelDrafts = {}; // per-panel-index bet amount / auto-cashout input state, preserved across re-renders

  function el(id) { return view.querySelector(`#${id}`); }

  function wsUrl() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = getToken();
    return `${proto}//${window.location.host}/ws/aviator?token=${encodeURIComponent(token || "")}`;
  }

  function connectWs() {
    if (destroyed) return;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      fallbackToPolling();
      return;
    }
    ws.addEventListener("open", () => {
      usingPoll = false;
      stopPolling();
      updateWsStatus(true);
      refreshState();
    });
    ws.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleWsEvent(msg.event, msg.data);
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

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function updateWsStatus(connected) {
    const badge = el("aviator-ws-status");
    if (!badge) return;
    badge.classList.toggle("connected", connected);
    badge.querySelector(".label").textContent = connected ? "Live" : "Reconnecting…";
  }

  function handleWsEvent(event, data) {
    if (destroyed) return;
    switch (event) {
      case "MULTIPLIER_UPDATE":
        if (latest?.state?.roundId === data.roundId) {
          localMultiplier = data.multiplier;
          renderMultiplierOnly();
        }
        break;
      case "ROUND_CREATED":
      case "BETTING_CLOSED":
      case "CRASH":
      case "ROUND_COMPLETED":
      case "BET_PLACED":
      case "CASHOUT":
      case "BET_SETTLED":
        refreshState();
        break;
      default:
        break;
    }
  }

  async function refreshState() {
    if (destroyed) return;
    try {
      latest = await api("/games/aviator/state");
    } catch {
      return;
    }
    if (destroyed) return;
    setBalance(latest.walletBalance);
    growthK = latest.state.growthK || growthK;
    if (latest.state.status === "flying") {
      flyingSince = latest.state.flyingStartedAt ? new Date(latest.state.flyingStartedAt).getTime() : Date.now();
      localMultiplier = latest.state.currentMultiplier || 1;
      startLocalAnim();
    } else {
      stopLocalAnim();
      localMultiplier = latest.state.status === "crashed" ? latest.state.crashMultiplier : 1;
    }
    render();
  }

  // Between WS/poll ticks, interpolate the multiplier smoothly client-side
  // from the known flight-start time and growth constant, purely visual --
  // the authoritative value always comes from the server via WS/poll.
  function startLocalAnim() {
    stopLocalAnim();
    const step = () => {
      if (destroyed || !flyingSince) return;
      const elapsedSec = (Date.now() - flyingSince) / 1000;
      localMultiplier = Math.exp(growthK * Math.max(0, elapsedSec));
      renderMultiplierOnly();
      animFrame = requestAnimationFrame(step);
    };
    animFrame = requestAnimationFrame(step);
  }

  function stopLocalAnim() {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  }

  function roundChipClass(m) {
    if (m < 1.5) return "low";
    if (m < 3) return "mid";
    return "high";
  }

  function renderMultiplierOnly() {
    const multEl = el("aviator-mult");
    const planeEl = el("aviator-plane");
    if (!multEl || !planeEl) return;
    multEl.textContent = `${localMultiplier.toFixed(2)}x`;
    const climb = Math.min(70, (localMultiplier - 1) * 18);
    const rise = Math.min(55, (localMultiplier - 1) * 12);
    planeEl.style.transform = `translate(${climb}vw, -${rise}vh) rotate(-12deg)`;
  }

  function betPanelHtml(index, myBet) {
    const draft = panelDrafts[index] || { amount: game.entryFee, autoCashout: "", autoEnabled: false };
    panelDrafts[index] = draft;

    if (myBet) {
      let body;
      if (latest.state.status === "flying" && myBet.status === "pending") {
        body = `<button class="cashout-btn" data-cashout="${myBet.id}" data-testid="aviator-cashout-btn-${index}">CASH OUT @ ${localMultiplier.toFixed(2)}x</button>`;
      } else if (myBet.status === "cashed") {
        body = `<div class="play-result win" data-testid="aviator-round-result-${index}">Cashed out @ ${myBet.cashedOutAt.toFixed(2)}x — +${myBet.prize} tokens</div>`;
      } else if (myBet.status === "lost") {
        body = `<div class="play-result lose" data-testid="aviator-round-result-${index}">Your bet flew away.</div>`;
      } else if (myBet.status === "void") {
        body = `<div class="play-result lose">Round voided — bet refunded.</div>`;
      } else {
        body = `<p class="pending-chip">Bet placed: ${myBet.betAmount} tokens${myBet.autoCashout ? ` · auto @ ${myBet.autoCashout}x` : ""}. Waiting for takeoff…</p>`;
      }
      return `<div class="bet-panel placed" data-testid="aviator-bet-panel-${index}">${body}</div>`;
    }

    const disabled = latest.state.status !== "betting";
    return `
      <div class="bet-panel" data-testid="aviator-bet-panel-${index}">
        <div class="field-row">
          <div class="field">
            <label>Bet Amount</label>
            <input type="number" min="${game.entryFee}" max="${latest.state.maxBet}" step="1" value="${draft.amount}" data-panel-amount="${index}" data-testid="aviator-bet-input-${index}">
          </div>
        </div>
        <div class="quick-amounts">
          ${QUICK_AMOUNTS.map((a) => `<button type="button" data-quick="${index}:${a}">${a}</button>`).join("")}
        </div>
        <label class="auto-cashout-toggle">
          <input type="checkbox" data-panel-auto-toggle="${index}" ${draft.autoEnabled ? "checked" : ""}>
          Auto cash-out at
          <input type="number" min="1.01" step="0.01" style="width:70px;" value="${draft.autoCashout}" data-panel-auto-value="${index}" ${draft.autoEnabled ? "" : "disabled"}>x
        </label>
        <button class="play-btn" data-place-bet="${index}" ${disabled ? "disabled" : ""} data-testid="aviator-bet-btn-${index}">Place Bet ${index + 1}</button>
      </div>`;
  }

  function liveActivityHtml() {
    const rows = latest.liveActivity || [];
    if (!rows.length) return `<p class="hint">No bets yet this round.</p>`;
    return rows
      .map((r) => {
        const statusClass = r.status === "cashed" ? "won" : r.status === "lost" ? "lost" : "pending";
        const statusText = r.status === "cashed" ? `+${r.cashedOutAt.toFixed(2)}x` : r.status === "lost" ? "lost" : "flying";
        return `<div class="live-activity-row">
          <span class="la-name${r.isBot ? " is-bot" : ""}">${escapeHtml(r.playerName || "Player")}</span>
          <span>${r.betAmount}</span>
          <span class="la-status ${statusClass}">${statusText}</span>
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
      } else if (s.status === "crashed") {
        window.AudioEngine.playSound("lose", { theme: THEME_KEY, dedupeMs: 10 });
        if (themeCtl) themeCtl.shake();
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

  // Bet lifecycle sound/celebration -- keyed by bet id + status so each
  // transition (placed -> cashed/lost) announces exactly once no matter
  // how many times render() re-runs while that status holds.
  function announceBetOutcomes(myBets) {
    if (!window.AudioEngine) return;
    (myBets || []).forEach((bet) => {
      if (!bet || bet.id === undefined) return;
      const key = `${bet.id}:${bet.status}`;
      if (announcedBets.has(key)) return;
      announcedBets.add(key);
      if (bet.status === "pending") {
        window.AudioEngine.playSound("bet", { theme: THEME_KEY });
      } else if (bet.status === "cashed") {
        const big = bet.cashedOutAt >= BIG_WIN_MULTIPLIER;
        window.AudioEngine.playSound(big ? "bigwin" : "cashout", { theme: THEME_KEY });
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
    const myBets = latest.myBets || [];
    handleRoundAudio(s);
    announceBetOutcomes(myBets);

    view.innerHTML = `
      <div class="play-arena" style="--glow: var(--neon-red);">
        <button class="back-link" id="back-to-grid" data-testid="back-to-games-btn">&larr; Back to Games</button>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h2>Aviator</h2>
          <span class="ws-status" id="aviator-ws-status"><span class="dot"></span><span class="label">Connecting…</span></span>
        </div>
        ${THEME_TAGLINE ? `<p class="theme-tagline">${escapeHtml(THEME_TAGLINE)}</p>` : ""}
        <p class="hint">Cash out before the plane crashes. The multiplier climbs continuously — wait too long and you lose the bet.</p>

        <div class="aviator-stage">
          <div class="aviator-plane" id="aviator-plane">✈️</div>
          <div class="aviator-multiplier" id="aviator-mult" data-testid="aviator-multiplier">${localMultiplier.toFixed(2)}x</div>
          <div class="aviator-status-line" id="aviator-status"></div>
        </div>

        <div class="aviator-bet-panels" id="aviator-bet-panels">
          ${[0, 1].slice(0, s.maxBetsPerRound || 2).map((i) => betPanelHtml(i, myBets[i])).join("")}
        </div>

        <div id="aviator-result"></div>

        <h3 class="dash-section-title">Round History</h3>
        <div class="recent-rounds" id="recent-rounds"></div>

        <h3 class="dash-section-title">Live Player Activity</h3>
        <div class="live-activity" id="live-activity">${liveActivityHtml()}</div>

        <div class="verify-panel" id="verify-panel">
          <h3 style="margin-top:0;">Provably Fair Verification</h3>
          <p class="hint">Every crash result is derived from a server seed (hashed and committed before betting closes), a client seed, and a round nonce. Once a round crashes, its server seed is revealed here — plug all three into the form below to recompute the same crash multiplier independently.</p>
          <div class="field-row">
            <div class="field"><label>Server Seed</label><input type="text" id="verify-server-seed" placeholder="revealed after crash"></div>
          </div>
          <div class="field-row">
            <div class="field"><label>Client Seed</label><input type="text" id="verify-client-seed"></div>
            <div class="field"><label>Nonce</label><input type="number" id="verify-nonce"></div>
          </div>
          <button class="play-btn" id="verify-btn" data-testid="aviator-verify-btn">Verify</button>
          <div class="verify-result" id="verify-result"></div>
        </div>
      </div>
    `;

    updateStatusLine();
    renderMultiplierOnly();
    renderRoundHistory();
    wireEvents();
    updateWsStatus(!usingPoll && ws && ws.readyState === WebSocket.OPEN);
  }

  function updateStatusLine() {
    const s = latest.state;
    const statusEl = el("aviator-status");
    const multEl = el("aviator-mult");
    const planeEl = el("aviator-plane");
    if (!statusEl) return;
    multEl.classList.remove("crashed", "cashed");
    planeEl.style.opacity = "1";
    if (s.status === "betting") {
      const secsLeft = Math.max(0, Math.ceil((new Date(s.bettingEndsAt).getTime() - Date.now()) / 1000));
      statusEl.textContent = `Betting closes in ${secsLeft}s`;
      planeEl.style.transform = "translate(0, 0)";
    } else if (s.status === "flying") {
      statusEl.textContent = "Flying…";
    } else if (s.status === "crashed") {
      multEl.classList.add("crashed");
      statusEl.textContent = `Crashed at ${s.crashMultiplier.toFixed(2)}x — next round starting soon…`;
      planeEl.style.opacity = "0.25";
    }
  }

  function renderRoundHistory() {
    const recentEl = el("recent-rounds");
    if (!recentEl) return;
    recentEl.innerHTML = (latest.recentRounds || [])
      .map(
        (r) =>
          `<span class="round-chip clickable ${roundChipClass(r.crashMultiplier)}" data-verify-round="${escapeHtml(r.serverSeedHash)}|${r.nonce}">${r.crashMultiplier.toFixed(2)}x</span>`
      )
      .join("");
    recentEl.querySelectorAll("[data-verify-round]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const [hash, nonce] = chip.dataset.verifyRound.split("|");
        el("verify-nonce").value = nonce;
        el("verify-client-seed").value = latest.state.clientSeed || "";
        el("verify-result").innerHTML = `<p class="hint">Server seed hash for this round: <b>${escapeHtml(hash)}</b>. Paste the revealed server seed (shown when this round crashed) above to verify.</p>`;
        el("verify-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
  }

  function wireEvents() {
    el("back-to-grid").addEventListener("click", () => onBack());

    view.querySelectorAll("[data-panel-amount]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const idx = e.target.dataset.panelAmount;
        panelDrafts[idx].amount = e.target.value;
      });
    });
    view.querySelectorAll("[data-quick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [idx, amount] = btn.dataset.quick.split(":");
        panelDrafts[idx].amount = amount;
        const input = view.querySelector(`[data-panel-amount="${idx}"]`);
        if (input) input.value = amount;
      });
    });
    view.querySelectorAll("[data-panel-auto-toggle]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const idx = e.target.dataset.panelAutoToggle;
        panelDrafts[idx].autoEnabled = e.target.checked;
        const valInput = view.querySelector(`[data-panel-auto-value="${idx}"]`);
        if (valInput) valInput.disabled = !e.target.checked;
      });
    });
    view.querySelectorAll("[data-panel-auto-value]").forEach((input) => {
      input.addEventListener("input", (e) => {
        panelDrafts[e.target.dataset.panelAutoValue].autoCashout = e.target.value;
      });
    });
    view.querySelectorAll("[data-place-bet]").forEach((btn) => {
      btn.addEventListener("click", () => placeBet(Number(btn.dataset.placeBet)));
    });
    view.querySelectorAll("[data-cashout]").forEach((btn) => {
      btn.addEventListener("click", () => doCashout(Number(btn.dataset.cashout)));
    });
    const verifyBtn = el("verify-btn");
    if (verifyBtn) verifyBtn.addEventListener("click", doVerify);
  }

  async function placeBet(index) {
    const draft = panelDrafts[index];
    const betAmount = parseInt(draft.amount, 10);
    const autoCashout = draft.autoEnabled && draft.autoCashout ? parseFloat(draft.autoCashout) : 0;
    const idempotencyKey = `${GAME_SLUG}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const btn = view.querySelector(`[data-place-bet="${index}"]`);
    if (btn) btn.disabled = true;
    try {
      const res = await api("/games/aviator/bet", { method: "POST", body: { betAmount, autoCashout, idempotencyKey } });
      setBalance(res.walletBalance);
      el("aviator-result").innerHTML = "";
      refreshState();
    } catch (err) {
      el("aviator-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
      if (btn) btn.disabled = false;
    }
  }

  async function doCashout(betId) {
    const btn = view.querySelector(`[data-cashout="${betId}"]`);
    if (btn) btn.disabled = true;
    try {
      const res = await api(`/games/aviator/bet/${betId}/cashout`, { method: "POST" });
      setBalance(res.walletBalance);
      el("aviator-result").innerHTML = `<div class="play-result win" data-testid="aviator-cashout-result">Cashed out @ ${res.cashedOutAt.toFixed(2)}x — +${res.prize} tokens</div>`;
      refreshState();
    } catch (err) {
      el("aviator-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
      if (btn) btn.disabled = false;
    }
  }

  async function doVerify() {
    const serverSeed = el("verify-server-seed").value.trim();
    const clientSeed = el("verify-client-seed").value.trim();
    const nonce = parseInt(el("verify-nonce").value, 10);
    if (!serverSeed || !clientSeed || !Number.isInteger(nonce)) {
      el("verify-result").innerHTML = `<p class="form-note error">Fill in server seed, client seed and nonce.</p>`;
      return;
    }
    try {
      const res = await api("/games/aviator/verify", { method: "POST", body: { serverSeed, clientSeed, nonce } });
      el("verify-result").innerHTML = `Computed crash multiplier: <b>${res.crashMultiplier}x</b><br>Server seed hash: ${escapeHtml(res.serverSeedHash)}<br><span style="font-size:0.75rem;">${escapeHtml(res.formula)}</span>`;
    } catch (err) {
      el("verify-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
    }
  }

  function mount(_view, _game, _onBack, _theme) {
    view = _view;
    game = _game;
    onBack = _onBack;
    themeCtl = _theme || null;
    destroyed = false;
    panelDrafts = {};
    announcedBets = new Set();
    lastRoundStatus = null;
    lastCountdownSec = null;
    connectWs();
    refreshState();
  }

  function unmount() {
    destroyed = true;
    stopLocalAnim();
    stopPolling();
    themeCtl = null;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  window.GAME_MODULES = window.GAME_MODULES || {};
  window.GAME_MODULES.aviator = { mount, unmount };
})();
