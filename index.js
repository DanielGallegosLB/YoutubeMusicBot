const { loadEnvFile } = require("process");
loadEnvFile()
// Primero que todo: garantiza que yt-dlp nunca descargue audio a disco.
const DownloadGuard = require("./handlers/DownloadGuard");
const MusicBot = require("./handlers/Client");
const { TOKEN } = require("./settings/config");

const client = new MusicBot();

const { monitorEventLoopDelay } = require("perf_hooks");
const _h = monitorEventLoopDelay({ resolution: 10 });
_h.enable();
setInterval(() => {
  const p99 = _h.percentile(99) / 1e6, max = _h.max / 1e6;
  if (max > 200) client.logger.warn(`[LoopLag] p99=${p99.toFixed(0)}ms max=${max.toFixed(0)}ms`);
  _h.reset();
}, 10000).unref();

module.exports = client;

client.start(TOKEN);
require("./handlers/MemoryGuard")(client);
DownloadGuard.startSweeper();
require("./handlers/PanelGuard")(client);

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
