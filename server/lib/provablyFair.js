const crypto = require("crypto");

// Shared provably-fair primitives used by every game. Each game commits a
// server seed hash before betting closes, reveals the server seed after the
// round resolves, and derives its own result (crash multiplier, 0-9 draw,
// dice/coin face, shuffled deck) from the same HMAC construction -- only the
// mapping from float/int to game result differs per game.

function generateServerSeed() {
  return crypto.randomBytes(32).toString("hex");
}

function hashServerSeed(serverSeed) {
  return crypto.createHash("sha256").update(serverSeed).digest("hex");
}

// Chains each round's client seed from the previous round's revealed server
// seed + client seed, so the whole sequence is independently reconstructible
// and no single party (including the house) can pre-select a favorable seed
// after seeing bets, since the hash was committed before betting closed.
function nextClientSeed(prevServerSeed, prevClientSeed) {
  if (!prevServerSeed || !prevClientSeed) return crypto.randomBytes(8).toString("hex");
  return crypto.createHash("sha256").update(prevServerSeed + prevClientSeed).digest("hex").slice(0, 16);
}

// Deterministic float in [0, 1). `cursor` lets a single round derive more
// than one independent value (e.g. dealing multiple cards) without reusing
// the same HMAC output.
function deriveFloat(serverSeed, clientSeed, nonce, cursor = 0) {
  const h = crypto.createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}:${cursor}`).digest("hex");
  return parseInt(h.slice(0, 13), 16) / Math.pow(2, 52);
}

function deriveInt(serverSeed, clientSeed, nonce, cursor, maxExclusive) {
  return Math.floor(deriveFloat(serverSeed, clientSeed, nonce, cursor) * maxExclusive);
}

const SUITS = ["S", "H", "D", "C"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

// Deterministic Fisher-Yates shuffle of a standard 52-card deck, seeded the
// same way as every other game's result -- reproducible by anyone given the
// revealed server seed, client seed and nonce.
function deriveShuffledDeck(serverSeed, clientSeed, nonce) {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = deriveInt(serverSeed, clientSeed, nonce, 1000 + i, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function rankOf(card) {
  return card.slice(0, -1);
}

module.exports = {
  generateServerSeed,
  hashServerSeed,
  nextClientSeed,
  deriveFloat,
  deriveInt,
  deriveShuffledDeck,
  rankOf,
  RANKS,
  SUITS,
};
