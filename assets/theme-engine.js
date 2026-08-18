// Game Theme Engine -- gives every game its own visual environment
// (gradient backdrop, decorative layers, an animated particle field, and
// win/lose/big-win celebration effects) without touching any game's own
// render logic.
//
// Integration point: each game module owns a `<div>` (`view`) that it
// wholesale replaces via `view.innerHTML = ...` on every state refresh
// (many times a second while a round is live). Injecting persistent
// background/particle DOM *inside* that div would get wiped on the next
// render. So `ThemeEngine.mount(hostEl, themeKey)` builds a wrapper
// structure instead:
//
//   hostEl (".game-theme-stage", passed in by games.js)
//     ├── .theme-bg-layer         (persistent: gradient, decor, canvas)
//     └── .theme-content          (returned as `content` -- THIS is what
//                                  gets passed to the game module as `view`)
//
// The game module never knows a theme layer exists; it just renders into
// `content` as if it were the plain view element it always was.

(function () {
  const prefersReducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isSmallScreen = window.matchMedia && window.matchMedia("(max-width: 480px)").matches;

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  // ---- Generic canvas particle field, parameterized per theme ----
  function startParticles(canvas, opts) {
    const ctx2d = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    let particles = [];
    let running = true;
    let lastTs = 0;
    let raf = null;
    const count = Math.max(4, Math.round(opts.count * (isSmallScreen ? 0.5 : 1)));

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      w = canvas.width = Math.max(1, Math.round(rect.width * dpr));
      h = canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);

    function spawn() {
      const angle = rand(opts.angleRange[0], opts.angleRange[1]);
      const speed = rand(opts.speedMin, opts.speedMax) * dpr;
      return {
        x: rand(0, w),
        y: rand(0, h),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: rand(opts.minSize, opts.maxSize) * dpr,
        color: opts.colors[Math.floor(Math.random() * opts.colors.length)],
        alpha: rand(0.35, 0.85),
        seed: Math.random() * 1000,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.02,
      };
    }
    for (let i = 0; i < count; i++) particles.push(spawn());

    function draw(p) {
      ctx2d.save();
      ctx2d.globalAlpha = Math.max(0, Math.min(1, p.alpha));
      ctx2d.translate(p.x, p.y);
      ctx2d.rotate(p.rot);
      ctx2d.fillStyle = p.color;
      ctx2d.strokeStyle = p.color;
      switch (opts.shape) {
        case "spark":
          ctx2d.lineWidth = Math.max(1, p.r * 0.3);
          ctx2d.beginPath();
          for (let i = 0; i < 4; i++) {
            const a = (i * Math.PI) / 2;
            ctx2d.moveTo(0, 0);
            ctx2d.lineTo(Math.cos(a) * p.r, Math.sin(a) * p.r);
          }
          ctx2d.stroke();
          break;
        case "square":
          ctx2d.fillRect(-p.r / 2, -p.r / 2, p.r, p.r);
          break;
        case "petal":
          ctx2d.beginPath();
          ctx2d.ellipse(0, 0, p.r, p.r * 0.5, 0, 0, Math.PI * 2);
          ctx2d.fill();
          break;
        case "bird":
          ctx2d.lineWidth = Math.max(1, p.r * 0.28);
          ctx2d.beginPath();
          ctx2d.moveTo(-p.r, 0);
          ctx2d.quadraticCurveTo(0, -p.r * 0.9, p.r, 0);
          ctx2d.quadraticCurveTo(0, p.r * 0.35, -p.r, 0);
          ctx2d.stroke();
          break;
        case "streak":
          ctx2d.lineWidth = Math.max(1, p.r * 0.35);
          ctx2d.beginPath();
          ctx2d.moveTo(-p.r * 1.6, 0);
          ctx2d.lineTo(p.r * 1.6, 0);
          ctx2d.stroke();
          break;
        default:
          ctx2d.beginPath();
          ctx2d.arc(0, 0, p.r, 0, Math.PI * 2);
          ctx2d.fill();
      }
      ctx2d.restore();
    }

    function step(ts) {
      if (!running) return;
      const dt = Math.min(48, ts - lastTs || 16);
      lastTs = ts;
      ctx2d.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.x += (p.vx * dt) / 16;
        p.y += (p.vy * dt) / 16;
        p.rot += (p.vrot * dt) / 16;
        if (opts.twinkle) p.alpha = 0.35 + 0.45 * Math.sin(ts / 500 + p.seed);
        if (p.x < -30) p.x = w + 30;
        if (p.x > w + 30) p.x = -30;
        if (p.y < -30) p.y = h + 30;
        if (p.y > h + 30) p.y = -30;
        draw(p);
      }
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);

    function onVisibility() {
      running = !document.hidden;
      if (running) {
        lastTs = 0;
        raf = requestAnimationFrame(step);
      } else if (raf) {
        cancelAnimationFrame(raf);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  // ---- Theme registry ----
  // Six themes architected so more can be added later by dropping in a new
  // entry here + matching CSS block in game-themes.css; only five are
  // currently assigned to games (see theme-config.js), the other two
  // (ocean, jurassic) are ready for future games.
  const THEMES = {
    sky: {
      className: "theme-sky",
      confettiColors: ["#7dd3fc", "#38bdf8", "#fef3c7", "#ffffff"],
      decorHtml: () => `<div class="deco-sun"></div><div class="deco-cloud deco-cloud-a"></div><div class="deco-cloud deco-cloud-b"></div><div class="deco-cloud deco-cloud-c"></div>`,
      particle: { count: 16, colors: ["#ffffff", "#e0f2fe"], minSize: 3, maxSize: 7, speedMin: 0.15, speedMax: 0.5, angleRange: [-0.15, 0.15], shape: "bird", twinkle: false },
    },
    desert: {
      className: "theme-desert",
      confettiColors: ["#fbbf24", "#f97316", "#fde68a", "#fff7ed"],
      decorHtml: () => `<div class="deco-dunes"></div><div class="deco-sun-desert"></div><div class="deco-ruins"></div>`,
      particle: { count: 22, colors: ["#fcd34d", "#fbbf24", "#fef3c7"], minSize: 1.5, maxSize: 3.5, speedMin: 0.15, speedMax: 0.4, angleRange: [-0.1, 0.3], shape: "circle", twinkle: false },
    },
    treasure: {
      className: "theme-treasure",
      confettiColors: ["#facc15", "#fbbf24", "#fde047", "#f59e0b"],
      decorHtml: () => `<div class="deco-vault-glow"></div><div class="deco-dunes deco-dunes-treasure"></div>`,
      particle: { count: 20, colors: ["#facc15", "#fde047", "#fff7cc"], minSize: 1.5, maxSize: 4, speedMin: 0.08, speedMax: 0.28, angleRange: [-1.7, -1.4], shape: "spark", twinkle: true },
    },
    royal: {
      className: "theme-royal",
      confettiColors: ["#f59e0b", "#facc15", "#e11d48", "#fff1d6"],
      decorHtml: () => `<div class="deco-royal-drape"></div><div class="deco-royal-arch"></div>`,
      particle: { count: 16, colors: ["#fbbf24", "#fde68a", "#fecdd3"], minSize: 3, maxSize: 6, speedMin: 0.1, speedMax: 0.3, angleRange: [1.3, 1.85], shape: "petal", twinkle: false },
    },
    futuristic: {
      className: "theme-futuristic",
      confettiColors: ["#22d3ee", "#a855f7", "#ec4899", "#e0f2fe"],
      decorHtml: () => `<div class="deco-grid"></div><div class="deco-scanline"></div>`,
      particle: { count: 26, colors: ["#22d3ee", "#a855f7", "#ec4899"], minSize: 1, maxSize: 3, speedMin: 0.2, speedMax: 0.6, angleRange: [-1.7, -1.4], shape: "square", twinkle: true },
    },
    ocean: {
      className: "theme-ocean",
      confettiColors: ["#22d3ee", "#0ea5e9", "#a5f3fc", "#ffffff"],
      decorHtml: () => `<div class="deco-waves"></div><div class="deco-coral"></div>`,
      particle: { count: 20, colors: ["#a5f3fc", "#67e8f9", "#ffffff"], minSize: 2, maxSize: 5, speedMin: 0.1, speedMax: 0.3, angleRange: [-1.7, -1.4], shape: "circle", twinkle: true },
    },
    jurassic: {
      className: "theme-jurassic",
      confettiColors: ["#84cc16", "#f97316", "#facc15", "#fef3c7"],
      decorHtml: () => `<div class="deco-jungle"></div><div class="deco-volcano"></div>`,
      particle: { count: 18, colors: ["#fb923c", "#fdba74", "#fef3c7"], minSize: 1.5, maxSize: 3.5, speedMin: 0.1, speedMax: 0.3, angleRange: [-1.7, -1.4], shape: "circle", twinkle: true },
    },
  };

  function celebrate(hostEl, kind, themeKey) {
    const theme = THEMES[themeKey] || THEMES.sky;
    if (kind === "lose") {
      hostEl.classList.add("theme-flash-lose");
      setTimeout(() => hostEl.classList.remove("theme-flash-lose"), 550);
      return;
    }
    if (prefersReducedMotion) {
      hostEl.classList.add(kind === "bigwin" ? "theme-flash-gold" : "theme-flash-win");
      setTimeout(() => hostEl.classList.remove("theme-flash-gold", "theme-flash-win"), 600);
      return;
    }
    const burst = document.createElement("div");
    burst.className = "theme-confetti-burst";
    const n = kind === "bigwin" ? 32 : 16;
    for (let i = 0; i < n; i++) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      piece.style.setProperty("--hue", theme.confettiColors[i % theme.confettiColors.length]);
      piece.style.setProperty("--x", `${Math.round(rand(-140, 140))}px`);
      piece.style.setProperty("--rot", `${Math.round(rand(-540, 540))}deg`);
      piece.style.setProperty("--delay", `${rand(0, 0.18).toFixed(2)}s`);
      piece.style.setProperty("--fall", `${Math.round(rand(160, 260))}px`);
      burst.appendChild(piece);
    }
    hostEl.appendChild(burst);
    setTimeout(() => burst.remove(), 1500);
    if (kind === "bigwin") {
      hostEl.classList.add("theme-flash-gold");
      hostEl.classList.add("theme-shake");
      setTimeout(() => hostEl.classList.remove("theme-flash-gold", "theme-shake"), 650);
    }
  }

  function mount(hostEl, themeKey) {
    const theme = THEMES[themeKey] || THEMES.sky;
    hostEl.classList.add("game-theme-stage", theme.className);
    hostEl.dataset.theme = themeKey;

    const bgLayer = document.createElement("div");
    bgLayer.className = "theme-bg-layer";
    bgLayer.innerHTML = theme.decorHtml ? theme.decorHtml() : "";
    hostEl.appendChild(bgLayer);

    let stopParticles = null;
    if (!prefersReducedMotion && theme.particle) {
      const canvas = document.createElement("canvas");
      canvas.className = "theme-particle-canvas";
      bgLayer.appendChild(canvas);
      stopParticles = startParticles(canvas, theme.particle);
    }

    const content = document.createElement("div");
    content.className = "theme-content";
    hostEl.appendChild(content);

    return {
      content,
      themeKey,
      celebrate: (kind) => celebrate(hostEl, kind, themeKey),
      shake: () => {
        hostEl.classList.add("theme-shake");
        setTimeout(() => hostEl.classList.remove("theme-shake"), 420);
      },
      unmount: () => {
        if (stopParticles) stopParticles();
        hostEl.innerHTML = "";
        hostEl.classList.remove("game-theme-stage", theme.className);
        delete hostEl.dataset.theme;
      },
    };
  }

  window.ThemeEngine = { mount, THEMES, prefersReducedMotion };
})();
