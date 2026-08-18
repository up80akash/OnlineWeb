const engine = require("./engine");
const bots = require("./bots");
const { createGameAdminRouter } = require("../../lib/gameAdmin");

module.exports = createGameAdminRouter(engine.GAME_ID, {
  defaults: engine.DEFAULTS,
  namespace: engine.NAMESPACE,
  engine,
  botCodes: bots.BOT_CODES,
});
