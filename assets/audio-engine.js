// Centralized audio manager, shared by every game.
//
// No binary audio assets ship with this project, so every sound and music
// bed is synthesized in real time with the Web Audio API (oscillators,
// filtered noise, envelopes) rather than loading .mp3/.ogg files. That
// keeps the whole system self-contained (no missing-asset 404s, nothing to
// license, near-zero payload) while still producing real, distinct audio
// per theme -- not a mocked/no-op sound layer.
//
// Public API (mirrors the brief):
//   AudioEngine.playSound(name, { theme, dedupeMs })
//   AudioEngine.playMusic(themeKey)
//   AudioEngine.stopMusic()
//   AudioEngine.setVolume(0.0..1.0)
//   AudioEngine.toggleMute()
//   AudioEngine.isMuted() / AudioEngine.getVolume()
//   AudioEngine.mountControl()  -- floating mute/volume widget, idempotent

(function () {
  const VOL_KEY = "fe_audio_volume";
  const MUTE_KEY = "fe_audio_muted";

  let ctx = null;
  let masterGain = null;
  let musicGain = null;
  let sfxGain = null;
  let unlocked = false;
  let currentMusic = null; // { theme, stop() }
  let muted = localStorage.getItem(MUTE_KEY) === "1";
  let volume = clamp(parseFloat(localStorage.getItem(VOL_KEY)), 0, 1, 0.55);
  const lastPlayedAt = Object.create(null);

  function clamp(v, min, max, fallback) {
    if (Number.isNaN(v) || v === null || v === undefined) return fallback;
    return Math.min(max, Math.max(min, v));
  }

  function ensureCtx() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      masterGain = ctx.createGain();
      masterGain.connect(ctx.destination);
      musicGain = ctx.createGain();
      musicGain.gain.value = 0.35;
      musicGain.connect(masterGain);
      sfxGain = ctx.createGain();
      sfxGain.gain.value = 1;
      sfxGain.connect(masterGain);
      applyVolume();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  function applyVolume() {
    if (!masterGain || !ctx) return;
    const target = muted ? 0 : volume;
    masterGain.gain.cancelScheduledValues(ctx.currentTime);
    masterGain.gain.setTargetAtTime(target, ctx.currentTime, 0.03);
  }

  // Browsers block audio until a user gesture -- unlock on the first
  // pointer/key interaction anywhere on the page.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    ensureCtx();
  }
  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    document.addEventListener(evt, unlock, { once: true, passive: true })
  );

  // ---- Synthesis helpers ----
  const noiseBufferCache = new Map();
  function noiseBuffer(seconds) {
    const key = Math.round(seconds * 100);
    if (noiseBufferCache.has(key)) return noiseBufferCache.get(key);
    const c = ensureCtx();
    const len = Math.max(1, Math.floor(c.sampleRate * seconds));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    noiseBufferCache.set(key, buf);
    return buf;
  }

  function envGain(c, dest, { attack = 0.01, decay = 0.15, peak = 0.25, sustain = 0 } = {}) {
    const g = c.createGain();
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(peak, c.currentTime + attack);
    if (sustain > 0) {
      g.gain.setValueAtTime(peak, c.currentTime + attack + sustain);
      g.gain.linearRampToValueAtTime(0, c.currentTime + attack + sustain + decay);
    } else {
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + attack + decay);
    }
    g.connect(dest);
    return g;
  }

  function tone(c, dest, { freq = 440, type = "sine", duration = 0.15, peak = 0.22, glideTo = null, detune = 0 }) {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), c.currentTime + duration);
    osc.detune.value = detune;
    const g = envGain(c, dest, { attack: 0.008, decay: duration, peak });
    osc.connect(g);
    osc.start();
    osc.stop(c.currentTime + duration + 0.05);
  }

  function chime(c, dest, freqs, { gap = 0.08, type = "triangle", peak = 0.2, duration = 0.28 }) {
    freqs.forEach((f, i) => {
      const t = c.currentTime + i * gap;
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      g.connect(dest);
      osc.connect(g);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    });
  }

  function burst(c, dest, { duration = 0.2, filterFreq = 1200, filterQ = 0.7, peak = 0.25, filterType = "bandpass" }) {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(duration + 0.05);
    const filt = c.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = filterFreq;
    filt.Q.value = filterQ;
    const g = envGain(c, dest, { attack: 0.005, decay: duration, peak });
    src.connect(filt);
    filt.connect(g);
    src.start();
    src.stop(c.currentTime + duration + 0.05);
  }

  // ---- Themed one-shot sound effects ----
  // Each theme gets its own timbre for the same semantic event so every
  // game has a distinct sound identity, while sharing the same synthesis
  // primitives above (no duplicated DSP code per game).
  const THEME_SFX = {
    sky: {
      click: (c, d) => tone(c, d, { freq: 720, type: "sine", duration: 0.05, peak: 0.15 }),
      bet: (c, d) => tone(c, d, { freq: 520, type: "sine", duration: 0.12, glideTo: 640, peak: 0.2 }),
      start: (c, d) => burst(c, d, { duration: 0.35, filterFreq: 2200, filterType: "highpass", peak: 0.12 }),
      countdown: (c, d) => tone(c, d, { freq: 880, type: "sine", duration: 0.06, peak: 0.16 }),
      cashout: (c, d) => chime(c, d, [660, 880, 1100], { type: "sine", peak: 0.2 }),
      win: (c, d) => chime(c, d, [660, 880, 1320], { type: "triangle", peak: 0.22 }),
      lose: (c, d) => tone(c, d, { freq: 380, type: "sine", duration: 0.4, glideTo: 120, peak: 0.18 }),
      bigwin: (c, d) => chime(c, d, [660, 880, 1100, 1320, 1760], { type: "triangle", peak: 0.26, gap: 0.07 }),
      notify: (c, d) => tone(c, d, { freq: 1000, type: "sine", duration: 0.08, peak: 0.15 }),
    },
    desert: {
      click: (c, d) => burst(c, d, { duration: 0.04, filterFreq: 1800, peak: 0.14 }),
      bet: (c, d) => tone(c, d, { freq: 220, type: "triangle", duration: 0.14, peak: 0.22 }),
      start: (c, d) => burst(c, d, { duration: 0.5, filterFreq: 900, filterQ: 0.5, peak: 0.16 }),
      countdown: (c, d) => tone(c, d, { freq: 300, type: "square", duration: 0.05, peak: 0.12 }),
      cashout: (c, d) => chime(c, d, [330, 440, 550], { type: "sawtooth", peak: 0.15 }),
      win: (c, d) => chime(c, d, [294, 370, 440], { type: "triangle", peak: 0.24 }),
      lose: (c, d) => burst(c, d, { duration: 0.3, filterFreq: 400, filterType: "lowpass", peak: 0.2 }),
      bigwin: (c, d) => chime(c, d, [220, 277, 330, 440, 554], { type: "sawtooth", peak: 0.25, gap: 0.09 }),
      notify: (c, d) => tone(c, d, { freq: 500, type: "triangle", duration: 0.1, peak: 0.15 }),
    },
    treasure: {
      click: (c, d) => tone(c, d, { freq: 1400, type: "sine", duration: 0.04, peak: 0.13 }),
      bet: (c, d) => tone(c, d, { freq: 700, type: "triangle", duration: 0.1, peak: 0.2 }),
      start: (c, d) => chime(c, d, [520, 660], { type: "sine", peak: 0.14, gap: 0.05 }),
      countdown: (c, d) => tone(c, d, { freq: 950, type: "sine", duration: 0.05, peak: 0.15 }),
      cashout: (c, d) => chime(c, d, [880, 1108, 1318], { type: "sine", peak: 0.22 }),
      win: (c, d) => {
        chime(c, d, [988, 1245, 1568], { type: "sine", peak: 0.24 });
        tone(c, d, { freq: 2400, type: "square", duration: 0.06, peak: 0.06 });
      },
      lose: (c, d) => tone(c, d, { freq: 300, type: "sine", duration: 0.35, glideTo: 90, peak: 0.16 }),
      bigwin: (c, d) => chime(c, d, [660, 880, 1108, 1318, 1760, 2217], { type: "sine", peak: 0.26, gap: 0.06 }),
      notify: (c, d) => tone(c, d, { freq: 1100, type: "sine", duration: 0.07, peak: 0.14 }),
    },
    royal: {
      click: (c, d) => tone(c, d, { freq: 880, type: "triangle", duration: 0.06, peak: 0.14 }),
      bet: (c, d) => chime(c, d, [392, 494], { type: "triangle", peak: 0.18, gap: 0.04 }),
      start: (c, d) => burst(c, d, { duration: 0.15, filterFreq: 3000, filterType: "highpass", peak: 0.1 }),
      countdown: (c, d) => tone(c, d, { freq: 660, type: "triangle", duration: 0.06, peak: 0.15 }),
      cashout: (c, d) => chime(c, d, [523, 659, 784], { type: "triangle", peak: 0.2 }),
      win: (c, d) => chime(c, d, [523, 659, 784, 988], { type: "triangle", peak: 0.24, gap: 0.09 }),
      lose: (c, d) => tone(c, d, { freq: 330, type: "sine", duration: 0.4, glideTo: 110, peak: 0.17 }),
      bigwin: (c, d) => chime(c, d, [392, 494, 587, 784, 988, 1175], { type: "triangle", peak: 0.27, gap: 0.08 }),
      notify: (c, d) => tone(c, d, { freq: 784, type: "triangle", duration: 0.09, peak: 0.15 }),
    },
    futuristic: {
      click: (c, d) => tone(c, d, { freq: 1200, type: "square", duration: 0.03, peak: 0.1 }),
      bet: (c, d) => tone(c, d, { freq: 300, type: "sawtooth", duration: 0.08, glideTo: 900, peak: 0.16 }),
      start: (c, d) => tone(c, d, { freq: 150, type: "square", duration: 0.3, glideTo: 1200, peak: 0.14 }),
      countdown: (c, d) => tone(c, d, { freq: 1000, type: "square", duration: 0.04, peak: 0.13 }),
      cashout: (c, d) => chime(c, d, [523, 784, 1046], { type: "square", peak: 0.16, gap: 0.05 }),
      win: (c, d) => chime(c, d, [440, 554, 659, 880], { type: "square", peak: 0.2, gap: 0.06 }),
      lose: (c, d) => tone(c, d, { freq: 500, type: "sawtooth", duration: 0.35, glideTo: 80, peak: 0.18 }),
      bigwin: (c, d) => chime(c, d, [330, 440, 554, 659, 880, 1108], { type: "square", peak: 0.25, gap: 0.05 }),
      notify: (c, d) => tone(c, d, { freq: 1500, type: "square", duration: 0.05, peak: 0.12 }),
    },
  };
  THEME_SFX.default = THEME_SFX.sky;

  function playSound(name, opts = {}) {
    if (muted) return;
    const c = ensureCtx();
    if (!c || c.state !== "running") return; // still autoplay-locked; skip silently
    const now = Date.now();
    const dedupeMs = opts.dedupeMs ?? 55;
    const key = `${opts.theme || "default"}:${name}`;
    if (lastPlayedAt[key] && now - lastPlayedAt[key] < dedupeMs) return;
    lastPlayedAt[key] = now;
    const table = THEME_SFX[opts.theme] || THEME_SFX.default;
    const recipe = table[name] || THEME_SFX.default[name];
    if (!recipe) return;
    try {
      recipe(c, sfxGain, opts);
    } catch (e) {
      /* audio glitches should never break gameplay */
    }
  }

  // ---- Ambient background music beds ----
  // Slow-moving detuned pad + a theme-appropriate texture layer (wind,
  // shimmer, drone) built from oscillators/filtered noise, looped until
  // explicitly stopped. Kept quiet by design -- this is a backing bed, not
  // a soundtrack -- so it never competes with sound effects.
  const MUSIC_BUILDERS = {
    sky: (c, dest) => {
      const nodes = [];
      const chord = [220, 277, 330];
      chord.forEach((f, i) => {
        const osc = c.createOscillator();
        osc.type = "sine";
        osc.frequency.value = f;
        osc.detune.value = i * 4;
        const g = c.createGain();
        g.gain.value = 0.05;
        osc.connect(g);
        g.connect(dest);
        osc.start();
        nodes.push(osc);
      });
      const windSrc = c.createBufferSource();
      windSrc.buffer = noiseBuffer(4);
      windSrc.loop = true;
      const windFilt = c.createBiquadFilter();
      windFilt.type = "bandpass";
      windFilt.frequency.value = 1800;
      windFilt.Q.value = 0.4;
      const windGain = c.createGain();
      windGain.gain.value = 0.03;
      windSrc.connect(windFilt);
      windFilt.connect(windGain);
      windGain.connect(dest);
      windSrc.start();
      nodes.push(windSrc);
      return nodes;
    },
    desert: (c, dest) => {
      const nodes = [];
      const drone = c.createOscillator();
      drone.type = "sine";
      drone.frequency.value = 110;
      const droneGain = c.createGain();
      droneGain.gain.value = 0.06;
      drone.connect(droneGain);
      droneGain.connect(dest);
      drone.start();
      nodes.push(drone);
      const windSrc = c.createBufferSource();
      windSrc.buffer = noiseBuffer(4);
      windSrc.loop = true;
      const windFilt = c.createBiquadFilter();
      windFilt.type = "lowpass";
      windFilt.frequency.value = 650;
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.08;
      const lfoGain = c.createGain();
      lfoGain.gain.value = 200;
      lfo.connect(lfoGain);
      lfoGain.connect(windFilt.frequency);
      lfo.start();
      const windGain = c.createGain();
      windGain.gain.value = 0.045;
      windSrc.connect(windFilt);
      windFilt.connect(windGain);
      windGain.connect(dest);
      windSrc.start();
      nodes.push(windSrc, lfo);
      return nodes;
    },
    treasure: (c, dest) => {
      const nodes = [];
      [261, 329, 392].forEach((f, i) => {
        const osc = c.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = f;
        osc.detune.value = i * 3;
        const g = c.createGain();
        g.gain.value = 0.045;
        osc.connect(g);
        g.connect(dest);
        osc.start();
        nodes.push(osc);
      });
      return nodes;
    },
    royal: (c, dest) => {
      const nodes = [];
      [196, 246, 293].forEach((f, i) => {
        const osc = c.createOscillator();
        osc.type = "sine";
        osc.frequency.value = f;
        osc.detune.value = i * 5;
        const g = c.createGain();
        g.gain.value = 0.05;
        osc.connect(g);
        g.connect(dest);
        osc.start();
        nodes.push(osc);
      });
      return nodes;
    },
    futuristic: (c, dest) => {
      const nodes = [];
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 82;
      const filt = c.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 400;
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.15;
      const lfoGain = c.createGain();
      lfoGain.gain.value = 150;
      lfo.connect(lfoGain);
      lfoGain.connect(filt.frequency);
      lfo.start();
      const g = c.createGain();
      g.gain.value = 0.05;
      osc.connect(filt);
      filt.connect(g);
      g.connect(dest);
      osc.start();
      nodes.push(osc, lfo);
      return nodes;
    },
  };

  function playMusic(themeKey) {
    if (currentMusic && currentMusic.theme === themeKey) return;
    stopMusic();
    const c = ensureCtx();
    if (!c) return;
    const builder = MUSIC_BUILDERS[themeKey];
    if (!builder) return;
    const nodes = builder(c, musicGain);
    currentMusic = {
      theme: themeKey,
      stop() {
        nodes.forEach((n) => {
          try {
            n.stop();
          } catch (e) {
            /* already stopped */
          }
        });
      },
    };
  }

  function stopMusic() {
    if (currentMusic) {
      currentMusic.stop();
      currentMusic = null;
    }
  }

  function setVolume(v) {
    volume = clamp(v, 0, 1, volume);
    localStorage.setItem(VOL_KEY, String(volume));
    applyVolume();
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    applyVolume();
    return muted;
  }

  function isMuted() {
    return muted;
  }

  function getVolume() {
    return volume;
  }

  // ---- Floating mute/volume control, mounted once for the whole app ----
  function mountControl() {
    if (document.getElementById("audio-control-widget")) return;
    const wrap = document.createElement("div");
    wrap.id = "audio-control-widget";
    wrap.className = "audio-control-widget";
    wrap.innerHTML = `
      <button type="button" class="audio-toggle-btn" id="audio-toggle-btn" aria-pressed="${muted}" aria-label="${muted ? "Unmute sound" : "Mute sound"}" title="${muted ? "Unmute sound" : "Mute sound"}">${muted ? "🔇" : "🔊"}</button>
      <input type="range" class="audio-volume-slider" id="audio-volume-slider" min="0" max="100" step="1" value="${Math.round(volume * 100)}" aria-label="Sound volume">
    `;
    document.body.appendChild(wrap);
    const btn = wrap.querySelector("#audio-toggle-btn");
    const slider = wrap.querySelector("#audio-volume-slider");
    btn.addEventListener("click", () => {
      unlock();
      const nowMuted = toggleMute();
      btn.textContent = nowMuted ? "🔇" : "🔊";
      btn.setAttribute("aria-pressed", String(nowMuted));
      btn.setAttribute("aria-label", nowMuted ? "Unmute sound" : "Mute sound");
      btn.title = nowMuted ? "Unmute sound" : "Mute sound";
    });
    slider.addEventListener("input", (e) => {
      unlock();
      setVolume(Number(e.target.value) / 100);
      if (muted && Number(e.target.value) > 0) {
        muted = false;
        localStorage.setItem(MUTE_KEY, "0");
        applyVolume();
        btn.textContent = "🔊";
        btn.setAttribute("aria-pressed", "false");
      }
    });
  }

  window.AudioEngine = {
    playSound,
    playMusic,
    stopMusic,
    setVolume,
    toggleMute,
    isMuted,
    getVolume,
    mountControl,
  };
})();
