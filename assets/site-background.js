// Shared colourful/joyful animated background, mounted once per page load
// behind all real content (see assets/site-background.css). Reused as-is
// across every non-game page -- login/register, and every dashboard's
// Profile/Wallet/Deposit/Withdrawal/Referral/Transaction-history/Games-
// listing panels -- instead of duplicating a bespoke background per page.
// Individual games keep their own distinct themes (assets/theme-engine.js);
// this is deliberately a separate, simpler, lighter-weight layer since it
// has to run continuously behind the *entire* app, not just one active
// game's stage.
(function () {
  const prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isSmallScreen = window.matchMedia && window.matchMedia("(max-width: 480px)").matches;
  const COLORS = ["#3b82f6", "#22d3ee", "#a855f7", "#ec4899", "#facc15"];

  function startParticles(canvas) {
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    let running = true;
    let lastTs = 0;
    let raf = null;
    const count = isSmallScreen ? 12 : 26;
    const particles = [];

    function resize() {
      w = canvas.width = Math.round(window.innerWidth * dpr);
      h = canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
    }
    resize();
    window.addEventListener("resize", resize);

    function spawn() {
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.18 * dpr,
        vy: (-0.06 - Math.random() * 0.2) * dpr,
        r: (1.5 + Math.random() * 3) * dpr,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        seed: Math.random() * 1000,
      };
    }
    for (let i = 0; i < count; i++) particles.push(spawn());

    function step(ts) {
      if (!running) return;
      const dt = Math.min(48, ts - lastTs || 16);
      lastTs = ts;
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.x += (p.vx * dt) / 16;
        p.y += (p.vy * dt) / 16;
        const alpha = 0.18 + 0.22 * Math.abs(Math.sin(ts / 1400 + p.seed));
        if (p.y < -20) {
          p.y = h + 20;
          p.x = Math.random() * w;
        }
        if (p.x < -20) p.x = w + 20;
        if (p.x > w + 20) p.x = -20;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);

    document.addEventListener("visibilitychange", () => {
      running = !document.hidden;
      if (running) {
        lastTs = 0;
        raf = requestAnimationFrame(step);
      } else if (raf) {
        cancelAnimationFrame(raf);
      }
    });
  }

  function mount() {
    if (document.getElementById("site-bg")) return; // never double-mount
    const bg = document.createElement("div");
    bg.id = "site-bg";
    bg.setAttribute("aria-hidden", "true");
    bg.innerHTML = `
      <div class="site-bg-gradient"></div>
      <div class="site-bg-blob site-bg-blob-a"></div>
      <div class="site-bg-blob site-bg-blob-b"></div>
      <div class="site-bg-blob site-bg-blob-c"></div>
      <div class="site-bg-blob site-bg-blob-d"></div>
      ${prefersReducedMotion ? "" : '<canvas class="site-bg-canvas"></canvas>'}
    `;
    document.body.insertBefore(bg, document.body.firstChild);

    if (!prefersReducedMotion) {
      startParticles(bg.querySelector(".site-bg-canvas"));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
