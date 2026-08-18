// Andar Bahar — classic card game. Self-contained module: own WS
// connection (with polling fallback + reconnect), own render loop, own
// bet/verify calls, own card-dealing animation driven by ANDAR_CARD/
// BAHAR_CARD/MATCH_FOUND events.

(function () {
  const GAME_SLUG = "andar_bahar";
  const QUICK_AMOUNTS = [5, 25, 100, 500];
  const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
  const THEME_KEY = (window.getGameTheme && window.getGameTheme(GAME_SLUG).theme) || "royal";
  const THEME_TAGLINE = (window.getGameTheme && window.getGameTheme(GAME_SLUG).tagline) || "";

  let themeCtl = null;
  let announcedBets = new Set();
  let lastRoundStatus = null;
  let lastCountdownSec = null;
  let lastRoundId = null;
  let lastDealtCount = 0;

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

  function cardHtml(card, extraClass = "") {
    if (!card) return `<div class="ab-card back ${extraClass}"></div>`;
    const rank = card.slice(0, -1);
    const suit = card.slice(-1);
    const red = suit === "H" || suit === "D";
    return `<div class="ab-card ${red ? "red" : "black"} ${extraClass}"><span class="ab-rank">${rank}</span><span class="ab-suit">${SUIT_SYMBOL[suit] || suit}</span></div>`;
  }

  function wsUrl() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws/andar-bahar?token=${encodeURIComponent(getToken() || "")}`;
  }

  function connectWs() {
    if (destroyed) return;
    try { ws = new WebSocket(wsUrl()); } catch { fallbackToPolling(); return; }
    ws.addEventListener("open", () => { usingPoll = false; stopPolling(); updateWsStatus(true); refreshState(); });
    ws.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (["ROUND_CREATED", "REFERENCE_CARD", "BETTING_CLOSED", "ANDAR_CARD", "BAHAR_CARD", "MATCH_FOUND", "RESULT_REVEALED", "ROUND_COMPLETED", "BET_PLACED", "BET_SETTLED"].includes(msg.event)) {
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
    pollTimer = setInterval(refreshState, 700);
  }

  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function updateWsStatus(connected) {
    const badge = el("ab-ws-status");
    if (!badge) return;
    badge.classList.toggle("connected", connected);
    badge.querySelector(".label").textContent = connected ? "Live" : "Reconnecting…";
  }

  async function refreshState() {
    if (destroyed) return;
    try { latest = await api("/games/andar-bahar/state"); } catch { return; }
    if (destroyed) return;
    setBalance(latest.walletBalance);
    render();
  }

  function myBetFor(side) {
    return (latest.myBets || []).find((b) => b.side === side);
  }

  function pileHtml(side) {
    const cards = (latest.state.dealt || []).filter((d) => d.side === side).map((d) => d.card);
    const winner = latest.state.status === "resolved" && latest.state.winningSide === side;
    const bet = myBetFor(side);
    return `
      <div class="ab-side-column${winner ? " winner" : ""}">
        <div class="ab-side-header">
          <h4>${side === "andar" ? "ANDAR" : "BAHAR"}</h4>
          <span class="ab-payout">${latest.state.payoutMultiplier}x</span>
        </div>
        <div class="ab-card-row">${cards.length ? cards.map((c) => cardHtml(c)).join("") : `<div class="ab-card-placeholder">—</div>`}</div>
        ${
          bet
            ? `<div class="pending-chip">Bet: ${bet.betAmount} tokens${bet.status === "won" ? " · WON +" + bet.prize : bet.status === "lost" ? " · lost" : ""}</div>`
            : `<div class="ab-bet-row">
                <input type="number" min="${latest.state.minBet}" max="${latest.state.maxBet}" value="${betAmount}" data-ab-amount="${side}" style="width:80px;">
                <button class="play-btn" data-ab-bet="${side}" data-testid="ab-bet-btn-${side}" ${latest.state.status !== "betting" ? "disabled" : ""}>Bet ${side === "andar" ? "Andar" : "Bahar"}</button>
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
    if (s.roundId !== lastRoundId) {
      lastRoundId = s.roundId;
      lastDealtCount = (s.dealt || []).length;
    }
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
    const dealtCount = (s.dealt || []).length;
    if (dealtCount > lastDealtCount) {
      window.AudioEngine.playSound("click", { theme: THEME_KEY, dedupeMs: 150 });
      lastDealtCount = dealtCount;
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
      <div class="play-arena" style="--glow: var(--neon-pink);">
        <button class="back-link" id="back-to-grid" data-testid="back-to-games-btn">&larr; Back to Games</button>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h2>Andar Bahar</h2>
          <span class="ws-status" id="ab-ws-status"><span class="dot"></span><span class="label">Connecting…</span></span>
        </div>
        ${THEME_TAGLINE ? `<p class="theme-tagline">${escapeHtml(THEME_TAGLINE)}</p>` : ""}
        <p class="hint">Bet Andar or Bahar. Cards deal alternately until one matches the reference card's rank.</p>

        <div class="ab-reference-row">
          <span class="hint">Reference Card</span>
          ${cardHtml(s.referenceCard)}
        </div>

        <div class="aviator-status-line" id="ab-status"></div>

        <div class="ab-table">${pileHtml("andar")}${pileHtml("bahar")}</div>

        <div id="ab-result"></div>

        <h3 class="dash-section-title">Round History</h3>
        <div class="recent-rounds" id="ab-recent-rounds">
          ${(latest.recentRounds || []).map((r) => `<span class="round-chip ${r.winningSide === "andar" ? "mid" : "high"}">${r.winningSide === "andar" ? "A" : "B"}</span>`).join("")}
        </div>

        <h3 class="dash-section-title">Live Player Activity</h3>
        <div class="live-activity" id="ab-live-activity">${liveActivityHtml()}</div>

        <div class="verify-panel" id="ab-verify-panel">
          <h3 style="margin-top:0;">Provably Fair Verification</h3>
          <p class="hint">The shuffled deck (and therefore the reference card and every dealt card) is derived from a committed server seed, a client seed, and the round nonce. Once a round resolves, its server seed is revealed — verify it below.</p>
          <div class="field-row"><div class="field"><label>Server Seed</label><input type="text" id="ab-verify-server-seed" placeholder="revealed after the round resolves"></div></div>
          <div class="field-row">
            <div class="field"><label>Client Seed</label><input type="text" id="ab-verify-client-seed"></div>
            <div class="field"><label>Nonce</label><input type="number" id="ab-verify-nonce"></div>
          </div>
          <button class="play-btn" id="ab-verify-btn" data-testid="ab-verify-btn">Verify</button>
          <div class="verify-result" id="ab-verify-result"></div>
        </div>
      </div>
    `;

    updateStatusLine();
    wireEvents();
    updateWsStatus(!usingPoll && ws && ws.readyState === WebSocket.OPEN);
  }

  function updateStatusLine() {
    const s = latest.state;
    const statusEl = el("ab-status");
    if (!statusEl) return;
    if (s.status === "betting") {
      const secsLeft = Math.max(0, Math.ceil((new Date(s.bettingEndsAt).getTime() - Date.now()) / 1000));
      statusEl.textContent = `Betting closes in ${secsLeft}s`;
    } else if (s.status === "dealing") {
      statusEl.textContent = "Dealing…";
    } else if (s.status === "resolved") {
      statusEl.textContent = `${s.winningSide === "andar" ? "ANDAR" : "BAHAR"} wins — next round starting soon…`;
    }
  }

  function wireEvents() {
    el("back-to-grid").addEventListener("click", () => onBack());
    view.querySelectorAll("[data-ab-amount]").forEach((input) => {
      input.addEventListener("input", (e) => { betAmount = parseInt(e.target.value, 10) || 0; });
    });
    view.querySelectorAll("[data-ab-bet]").forEach((btn) => {
      btn.addEventListener("click", () => placeBet(btn.dataset.abBet));
    });
    const verifyBtn = el("ab-verify-btn");
    if (verifyBtn) verifyBtn.addEventListener("click", doVerify);
  }

  async function placeBet(side) {
    const amount = parseInt(betAmount, 10);
    const idempotencyKey = `andar_bahar:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
      const res = await api("/games/andar-bahar/bet", { method: "POST", body: { side, betAmount: amount, idempotencyKey } });
      setBalance(res.walletBalance);
      el("ab-result").innerHTML = "";
      refreshState();
    } catch (err) {
      el("ab-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function doVerify() {
    const serverSeed = el("ab-verify-server-seed").value.trim();
    const clientSeed = el("ab-verify-client-seed").value.trim();
    const nonce = parseInt(el("ab-verify-nonce").value, 10);
    if (!serverSeed || !clientSeed || !Number.isInteger(nonce)) {
      el("ab-verify-result").innerHTML = `<p class="form-note error">Fill in server seed, client seed and nonce.</p>`;
      return;
    }
    try {
      const res = await api("/games/andar-bahar/verify", { method: "POST", body: { serverSeed, clientSeed, nonce } });
      el("ab-verify-result").innerHTML = `Reference: <b>${res.referenceCard}</b> — Winner: <b>${res.winningSide}</b> after ${res.dealt.length} cards dealt.<br><span style="font-size:0.75rem;">${escapeHtml(res.formula)}</span>`;
    } catch (err) {
      el("ab-verify-result").innerHTML = `<p class="form-note error">${escapeHtml(err.message)}</p>`;
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
    lastRoundId = null;
    lastDealtCount = 0;
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
  window.GAME_MODULES.andar_bahar = { mount, unmount };
})();
