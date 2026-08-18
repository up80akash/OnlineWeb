function getToken() {
  return localStorage.getItem("fe_token");
}

function requireRole(role) {
  const token = getToken();
  const storedRole = localStorage.getItem("fe_role");
  if (!token || storedRole !== role) {
    window.location.href = "admin-login.html";
    throw new Error("Not authenticated");
  }
}

function logout() {
  localStorage.removeItem("fe_token");
  localStorage.removeItem("fe_role");
  localStorage.removeItem("fe_name");
  window.location.href = "admin-login.html";
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    logout();
    throw new Error("Session expired");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

// Like api(), but for multipart/form-data submissions (file uploads). Must
// NOT set a Content-Type header itself -- the browser sets the multipart
// boundary automatically when the body is a FormData instance.
async function apiUpload(path, formData) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}` },
    body: formData,
  });

  if (res.status === 401) {
    logout();
    throw new Error("Session expired");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

// Authenticated image endpoints (deposit screenshots, support attachments)
// can't be used directly as an <img src> -- the browser won't attach our
// Bearer token to that request. Fetch it manually and hand back a local
// blob URL instead. Caller is responsible for revoking it (see
// closeImageLightbox) once it's no longer displayed, to avoid leaking
// memory across a long dashboard session.
async function fetchAuthedImageUrl(path) {
  const res = await fetch(`/api${path}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    throw new Error("Could not load image.");
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

let lightboxObjectUrl = null;

// Shared lightbox for viewing deposit screenshots / support attachments.
// Expects a `#image-lightbox` overlay (with `#image-lightbox-img` and
// `#image-lightbox-close`) to exist on the page -- see dashboard.css.
async function openImageLightbox(path) {
  const overlay = document.getElementById("image-lightbox");
  const img = document.getElementById("image-lightbox-img");
  if (!overlay || !img) return;
  overlay.classList.remove("hidden");
  img.classList.add("loading");
  img.src = "";
  try {
    const url = await fetchAuthedImageUrl(path);
    if (lightboxObjectUrl) URL.revokeObjectURL(lightboxObjectUrl);
    lightboxObjectUrl = url;
    img.src = url;
  } catch {
    overlay.classList.add("hidden");
    alert("Could not load the image.");
  } finally {
    img.classList.remove("loading");
  }
}

function closeImageLightbox() {
  const overlay = document.getElementById("image-lightbox");
  if (overlay) overlay.classList.add("hidden");
  if (lightboxObjectUrl) {
    URL.revokeObjectURL(lightboxObjectUrl);
    lightboxObjectUrl = null;
  }
}

function initImageLightbox() {
  const overlay = document.getElementById("image-lightbox");
  if (!overlay) return;
  document.getElementById("image-lightbox-close")?.addEventListener("click", closeImageLightbox);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeImageLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeImageLightbox();
  });
}

// Wires a file <input type="file">'s change event to a live preview
// (thumbnail + filename + remove button), client-side type/size checks,
// and returns a small controller so the caller can read the picked file at
// submit time and reset the picker afterward. Shared between the deposit
// screenshot upload and the support attachment upload so validation and UX
// stay identical in both places.
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function initImagePicker({ inputId, previewId, dropZoneId }) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  if (!input || !preview) return null;
  let currentFile = null;
  let objectUrl = null;

  function render() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    if (!currentFile) {
      preview.innerHTML = "";
      preview.classList.remove("has-file");
      return;
    }
    objectUrl = URL.createObjectURL(currentFile);
    preview.classList.add("has-file");
    preview.innerHTML = `
      <img src="${objectUrl}" alt="Selected image preview">
      <div class="image-picker-meta">
        <span class="image-picker-name">${escapeHtml(currentFile.name)}</span>
        <button type="button" class="image-picker-remove" data-testid="${inputId}-remove">Remove</button>
      </div>
    `;
    preview.querySelector(".image-picker-remove").addEventListener("click", () => setFile(null));
  }

  function setFile(file) {
    if (file) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        alert("Invalid image format. Upload a JPG, PNG or WebP image.");
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        alert(`Image exceeds the maximum allowed size of ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`);
        return;
      }
    }
    currentFile = file;
    const dt = new DataTransfer();
    if (file) dt.items.add(file);
    input.files = dt.files;
    render();
  }

  input.addEventListener("change", () => setFile(input.files[0] || null));

  const dropZone = dropZoneId ? document.getElementById(dropZoneId) : null;
  if (dropZone) {
    dropZone.addEventListener("click", (e) => {
      if (e.target.closest(".image-picker-remove")) return;
      input.click();
    });
    dropZone.addEventListener("dragover", (e) => e.preventDefault());
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) setFile(file);
    });
  }

  return {
    getFile: () => currentFile,
    reset: () => setFile(null),
  };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso.replace(" ", "T") + "Z").toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// URL-based tab routing -- the active top-level dash-tab (Profile/Wallet/
// Games/... on the user dashboard; Overview/Users/Games/... on admin/
// sub-admin) is reflected in the URL hash as "#/<name>" (name = the tab's
// data-target with the "panel-" prefix stripped), so a browser refresh,
// direct link, or back/forward restores the same section instead of always
// landing back on the first tab. The "games" tab is the one exception: its
// own richer sub-route ("#/games/<slug>", already implemented in games.js
// for deep-linking a specific game) stays entirely games.js's
// responsibility -- this router only ever *reads* that hash to know "games"
// is the active top-level tab, it never overwrites it.
function panelNameFromHash() {
  const m = window.location.hash.match(/^#\/([a-z0-9_-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Fires whenever a panel becomes the visible one (tab click, hash-restore
// on load, or back/forward) -- dashboard scripts listen for this to refresh
// that panel's data on demand instead of only ever loading it once at
// startup, so switching back to e.g. the Wallet tab after playing a game
// shows current numbers rather than whatever was last fetched.
function dispatchPanelShown(name) {
  document.dispatchEvent(new CustomEvent("dash:panelshown", { detail: { panel: name } }));
}

function activateTabByName(name, { silent } = {}) {
  const tab = document.querySelector(`.dash-tab[data-target="panel-${name}"]`);
  if (!tab) return false;
  document.querySelectorAll(".dash-tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".dash-panel").forEach((p) => p.classList.remove("active"));
  tab.classList.add("active");
  document.getElementById(tab.dataset.target).classList.add("active");
  if (!silent) dispatchPanelShown(name);
  return true;
}

function initTabs() {
  const tabs = document.querySelectorAll(".dash-tab");
  const panels = document.querySelectorAll(".dash-panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.target).classList.add("active");
      const name = tab.dataset.target.replace(/^panel-/, "");
      if (name !== "games" && window.location.hash !== `#/${name}`) {
        window.location.hash = `#/${name}`;
      }
      dispatchPanelShown(name);
    });
  });

  // Restore the section named in the URL on load (refresh / direct link).
  const initialName = panelNameFromHash();
  if (initialName) activateTabByName(initialName);

  // Back/forward between top-level sections (skip while the games tab owns
  // a "#/games/<slug>" sub-route -- games.js's own hashchange listener
  // handles re-mounting the right game; we only need to make sure the
  // Games *tab* itself is the active one, which activateTabByName already
  // does whenever the hash's first segment is "games").
  window.addEventListener("hashchange", () => {
    const name = panelNameFromHash();
    if (name) activateTabByName(name);
  });
}

// Every dash-panel gets a visible "Refresh" button that re-fetches just
// that panel's data (via the same dash:panelshown event tab-switching
// already dispatches) rather than reloading the whole page -- unless the
// panel already has its own hand-placed one (user-dashboard.html's Wallet/
// Referral/Profile panels), or it's the Games tab, which manages its own
// per-game refresh inside each game module instead.
function initPanelRefreshButtons() {
  document.querySelectorAll(".dash-panel").forEach((panel) => {
    const name = panel.id.replace(/^panel-/, "");
    if (name === "games") return;
    if (panel.querySelector('[id$="-refresh-btn"]')) return;

    const row = document.createElement("div");
    row.style.cssText = "display:flex; justify-content:flex-end; margin-bottom:0.75rem;";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "inline-btn ghost";
    btn.dataset.testid = `${name}-refresh-btn`;
    btn.textContent = "↻ Refresh";
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      btn.disabled = true;
      dispatchPanelShown(name);
      setTimeout(() => {
        btn.disabled = false;
      }, 500);
    });
    row.appendChild(btn);
    panel.insertBefore(row, panel.firstChild);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const nameEl = document.getElementById("dash-user-name");
  if (nameEl) nameEl.textContent = localStorage.getItem("fe_name") || "";

  const logoutBtn = document.getElementById("dash-logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);

  initTabs();
  initPanelRefreshButtons();
  initImageLightbox();
});
