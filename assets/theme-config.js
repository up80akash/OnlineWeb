// Per-game theme assignment. This is the single place a future developer
// edits to point a game at a different theme, or to register a new game --
// nothing else in games.js/theme-engine.js/audio-engine.js needs to change.
// The theme itself (colors, particles, backgrounds, sound timbre) lives in
// theme-engine.js (visuals) and audio-engine.js (sound); this file only
// wires "this game -> this theme" plus small per-game display metadata.
//
//   gameTheme = {
//     theme: "<key into ThemeEngine.THEMES / AudioEngine's theme SFX table>",
//     music: "<key into AudioEngine's music beds, usually same as theme>",
//     tagline: "<short flavor line shown under the game title>",
//   }

window.GAME_THEME_CONFIG = {
  aviator: {
    theme: "sky",
    music: "sky",
    tagline: "Climb through open sky — cash out before the engine cuts out.",
  },
  dice_roll: {
    theme: "desert",
    music: "desert",
    tagline: "Ancient temple dice, carved from sun-baked stone.",
  },
  coin_flip: {
    theme: "treasure",
    music: "treasure",
    tagline: "A desert vault, a single gold coin, one call in the air.",
  },
  andar_bahar: {
    theme: "royal",
    music: "royal",
    tagline: "A royal card room — silk, gold trim, and a dealer's steady hand.",
  },
  number_prediction: {
    theme: "futuristic",
    music: "futuristic",
    tagline: "A neon prediction grid running on borrowed future light.",
  },
};

function getGameTheme(slug) {
  return window.GAME_THEME_CONFIG[slug] || { theme: "sky", music: "sky", tagline: "" };
}
window.getGameTheme = getGameTheme;
