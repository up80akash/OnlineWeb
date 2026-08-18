const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENV_PATH = path.join(__dirname, ".env");
require("dotenv").config({ path: ENV_PATH });

if (!process.env.JWT_SECRET) {
  const secret = crypto.randomBytes(32).toString("hex");
  fs.appendFileSync(ENV_PATH, `JWT_SECRET=${secret}\n`);
  process.env.JWT_SECRET = secret;
}

const http = require("http");
const express = require("express");
require("./db"); // creates tables + seeds the admin account on first run

const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const subadminRoutes = require("./routes/subadmin");
const userRoutes = require("./routes/user");
const accountRoutes = require("./routes/account");
const gamesRoutes = require("./routes/games");
const gameWs = require("./lib/ws");
const aviatorEngine = require("./games/aviator/engine");
const numberPredictionEngine = require("./games/number-prediction/engine");
const andarBaharEngine = require("./games/andar-bahar/engine");
const diceRollEngine = require("./games/dice-roll/engine");
const coinFlipEngine = require("./games/coin-flip/engine");

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_ROOT = path.join(__dirname, "..");

app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/subadmin", subadminRoutes);
app.use("/api/user", userRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/games", gamesRoutes);

app.get("/", (req, res) => res.redirect("/login.html?tab=register"));

app.use(express.static(SITE_ROOT));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const server = http.createServer(app);
gameWs.init(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Fun & Earning server running at http://localhost:${PORT}`);
  aviatorEngine.start();
  numberPredictionEngine.start();
  andarBaharEngine.start();
  diceRollEngine.start();
  coinFlipEngine.start();
});
