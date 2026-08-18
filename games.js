// Game lobby: catalog grid, search/category filter, and a tiny hash router
// so each game gets its own shareable URL (#/games, #/games/aviator, ...)
// without pulling in a router library. Each game's actual play experience
// lives in its own module (see games/<slug>.js), registered into
// window.GAME_MODULES -- this file never contains game-specific logic.

requireRole("user");

const GAME_ICONS = {
  aviator: "✈️",
  number_prediction: "🔢",
  andar_bahar: "🃏",
  dice_roll: "🎲",
  coin_flip: "🪙",
};

const GAME_CATEGORIES = {
  aviator: "Crash",
  number_prediction: "Prediction",
  andar_bahar: "Cards",
  dice_roll: "Dice",
  coin_flip: "Coin",
};

window.GAME_MODULES = window.GAME_MODULES || {};

let gamesCatalog = [];
let activeModule = null;
let activeTheme = null; // ThemeEngine controller for the currently mounted game
let activeCategory = "All";
let searchTerm = "";

function gridView() { return document.getElementById("games-grid-view"); }
function playView() { return document.getElementById("game-play-view"); }

function recentlyPlayed() {
  try { return JSON.parse(localStorage.getItem("fe_recent_games") || "[]"); } catch { return []; }
}

function markRecentlyPlayed(slug) {
  const list = recentlyPlayed().filter((s) => s !== slug);
  list.unshift(slug);
  localStorage.setItem("fe_recent_games", JSON.stringify(list.slice(0, 5)));
}

function favorites() {
  try { return new Set(JSON.parse(localStorage.getItem("fe_favorite_games") || "[]")); } catch { return new Set(); }
}

function toggleFavorite(slug) {
  const set = favorites();
  if (set.has(slug)) set.delete(slug); else set.add(slug);
  localStorage.setItem("fe_favorite_games", JSON.stringify([...set]));
}

async function renderGamesGrid() {
  gamesCatalog = await api("/games");
  renderToolbar();
  renderGrid();
  loadWinTicker();
}

function renderToolbar() {
  const toolbar = document.getElementById("games-toolbar");
  if (!toolbar) return;
  const categories = ["All", ...new Set(Object.values(GAME_CATEGORIES))];
  toolbar.innerHTML = `
    <input type="text" class="games-search" id="games-search-input" placeholder="Search games..." value="${escapeHtml(searchTerm)}" data-testid="games-search-input">
    <div class="games-category-row">
      ${categories.map((c) => `<button class="games-category-chip${c === activeCategory ? " active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")}
    </div>
  `;
  document.getElementById("games-search-input").addEventListener("input", (e) => {
    searchTerm = e.target.value;
    renderGrid();
  });
  toolbar.querySelectorAll(".games-category-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      activeCategory = chip.dataset.cat;
      renderToolbar();
      renderGrid();
    });
  });
}

function cardHtml(g, favSet) {
  const isFav = favSet.has(g.slug);
  return `
    <div class="game-card${g.status !== "online" ? " offline" : ""}" data-slug="${g.slug}" data-testid="game-card-${g.slug}">
      ${g.status !== "online" ? `<span class="game-badge">Coming Soon</span>` : `<span class="game-badge" data-fav="${g.slug}" style="cursor:pointer;">${isFav ? "★ Favorite" : "☆ Favorite"}</span>`}
      <div class="game-icon">${GAME_ICONS[g.slug] || "🎮"}</div>
      <h4>${escapeHtml(g.name)}</h4>
      <p>${escapeHtml(g.description)}</p>
      <div class="game-meta">
        <span>Min <b>${g.entryFee}</b></span>
        <span>${g.slug === "aviator" ? "Max <b>100x</b>" : `Payout <b>${g.winMultiplier}x</b>`}</span>
      </div>
      ${g.status === "online" ? `<span class="play-now-pill">PLAY NOW</span>` : ""}
    </div>`;
}

function renderGrid() {
  const grid = document.getElementById("games-grid");
  const favSet = favorites();
  const term = searchTerm.trim().toLowerCase();

  let list = gamesCatalog.filter((g) => {
    if (activeCategory !== "All" && GAME_CATEGORIES[g.slug] !== activeCategory) return false;
    if (term && !(g.name.toLowerCase().includes(term) || g.description.toLowerCase().includes(term))) return false;
    return true;
  });

  const recent = recentlyPlayed().map((slug) => gamesCatalog.find((g) => g.slug === slug)).filter(Boolean);
  const recentHtml = !term && activeCategory === "All" && recent.length
    ? `<h3 class="dash-section-title" style="margin-top:0;">Recently Played</h3><div class="games-grid" style="margin-bottom:1.5rem;">${recent.map((g) => cardHtml(g, favSet)).join("")}</div><h3 class="dash-section-title">All Games</h3>`
    : "";

  grid.innerHTML = list.length ? list.map((g) => cardHtml(g, favSet)).join("") : `<p class="hint">No games match your search.</p>`;
  const recentContainer = document.getElementById("games-recent-row");
  if (recentContainer) recentContainer.innerHTML = recentHtml;

  document.querySelectorAll("#games-recent-row .game-card, #games-grid .game-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-fav]")) return;
      const g = gamesCatalog.find((x) => x.slug === card.dataset.slug);
      if (g && g.status === "online") navigateToGame(g.slug);
    });
    const favBtn = card.querySelector("[data-fav]");
    if (favBtn) {
      favBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(favBtn.dataset.fav);
        renderGrid();
      });
    }
  });
}

async function loadWinTicker() {
  const wins = await api("/games/recent-wins");
  const wrap = document.getElementById("win-ticker");
  const track = document.getElementById("win-ticker-track");
  if (!wins.length) { wrap.style.display = "none"; return; }
  const items = [...wins, ...wins]
    .map((w) => `<span class="win-chip">${escapeHtml(w.username)} won <b>+${w.prize}</b> on ${escapeHtml((w.gameSlug || "").replace(/_/g, " "))}</span>`)
    .join("");
  track.innerHTML = items;
  wrap.style.display = "block";
}

// ---- Hash router: #/games, #/games/<slug> ----
function currentSlugFromHash() {
  const m = window.location.hash.match(/^#\/games\/([a-z_]+)/);
  return m ? m[1] : null;
}

function navigateToGame(slug) {
  window.location.hash = `#/games/${slug}`;
}

function navigateToGrid() {
  window.location.hash = "#/games";
}

function teardownActiveGame() {
  if (activeModule) { activeModule.unmount(); activeModule = null; }
  if (activeTheme) { activeTheme.unmount(); activeTheme = null; }
  if (window.AudioEngine) window.AudioEngine.stopMusic();
}

function showGrid() {
  teardownActiveGame();
  playView().style.display = "none";
  playView().innerHTML = "";
  gridView().style.display = "block";
  renderGamesGrid();
}

function showGame(slug) {
  const g = gamesCatalog.find((x) => x.slug === slug);
  const module = window.GAME_MODULES[slug];
  if (!g || !module || g.status !== "online") { navigateToGrid(); return; }

  markRecentlyPlayed(slug);
  gridView().style.display = "none";
  const view = playView();
  view.style.display = "block";
  view.innerHTML = "";
  teardownActiveGame();

  // Every game gets its own themed stage (background, particles, win/lose
  // effects) built by the Game Theme Engine. The stage wraps a plain
  // content <div> that's handed to the game module as `view` -- from the
  // module's point of view nothing changed, it still owns and fully
  // re-renders that element on every state refresh.
  const themeCfg = window.getGameTheme ? window.getGameTheme(slug) : { theme: "sky", music: "sky" };
  const stageHost = document.createElement("div");
  view.appendChild(stageHost);
  activeTheme = window.ThemeEngine ? window.ThemeEngine.mount(stageHost, themeCfg.theme) : null;
  const mountTarget = activeTheme ? activeTheme.content : stageHost;

  // Generic button-click feedback for every game, themed to match --
  // individual games only need to call playSound for semantic events (bet
  // placed, win, lose, countdown...) since basic tactile clicks are
  // covered here once for all of them.
  stageHost.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest("button");
      if (!btn || btn.disabled || !window.AudioEngine) return;
      window.AudioEngine.playSound("click", { theme: themeCfg.theme, dedupeMs: 40 });
    },
    true
  );

  if (window.AudioEngine) {
    window.AudioEngine.playMusic(themeCfg.music);
    window.AudioEngine.playSound("start", { theme: themeCfg.theme });
  }

  activeModule = module;
  module.mount(mountTarget, g, navigateToGrid, activeTheme);
}

async function routeFromHash() {
  if (!gamesCatalog.length) gamesCatalog = await api("/games");
  const slug = currentSlugFromHash();
  if (slug) showGame(slug);
  else showGrid();
}

window.addEventListener("hashchange", routeFromHash);

document.addEventListener("DOMContentLoaded", () => {
  if (window.AudioEngine) window.AudioEngine.mountControl();

  document.querySelectorAll(".dash-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.target === "panel-games") {
        if (!window.location.hash.startsWith("#/games")) navigateToGrid();
        else routeFromHash(); // hash unchanged since we left -- hashchange won't fire, so re-mount explicitly
      } else if (activeModule) {
        // Leaving the Games tab entirely -- stop the live game's WS/polling
        // and theme audio/animation rather than letting them run in the
        // background; #/games/<slug> stays in the URL so switching back to
        // the Games tab resumes the same game.
        teardownActiveGame();
      }
    });
  });
  routeFromHash();
});
