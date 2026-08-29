const { loadEnvFile } = require("process");
loadEnvFile()
const MusicBot = require("./handlers/Client");
const { TOKEN } = require("./settings/config");

const client = new MusicBot();

module.exports = client;

client.start(TOKEN);

process.on("unhandledRejection", (reason, p) => {
  try {
    client.logger.error(`[Unhandled Rejection]`, reason);
  } catch {
    console.log(" [Error_Handling] :: Unhandled Rejection/Catch");
    console.log(reason, p);
  }
});

process.on("uncaughtException", (err, origin) => {
  try {
    client.logger.error(`[Uncaught Exception]`, err);
  } catch {
    console.log(" [Error_Handling] :: Uncaught Exception/Catch");
    console.log(err, origin);
  }
});

process.on("uncaughtExceptionMonitor", (err, origin) => {
  try {
    client.logger.error(`[Uncaught Exception Monitor]`, err);
  } catch {
    console.log(" [Error_Handling] :: Uncaught Exception/Catch (MONITOR)");
    console.log(err, origin);
  }
});
