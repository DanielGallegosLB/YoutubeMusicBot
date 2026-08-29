const fs = require("fs");
const path = require("path");
const { format } = require("util");

const logFile = path.join(process.cwd(), "logs.txt");

function getTimestamp() {
  const now = new Date();
  const pad = (n, d = 2) => String(n).padStart(d, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

// Intercept every console call so that ALL output goes to logs.txt
// (including direct console.log/error/warn from the bot and libraries),
// not just the client.logger calls. Guarded so it only installs once.
if (!global.__consoleLoggingInstalled) {
  global.__consoleLoggingInstalled = true;

  const colors = { log: "32", info: "36", warn: "33", error: "31", debug: "34" };
  const fileLevel = { log: "INFO", info: "INFO", warn: "WARN", error: "ERROR", debug: "DEBUG" };

  for (const method of Object.keys(colors)) {
    const original = console[method];
    console[method] = function (...args) {
      const message = format(...args);
      const entry = `[${getTimestamp()}] [${fileLevel[method]}] ${message}`;
      try {
        fs.appendFileSync(logFile, entry + "\n");
      } catch {}
      original(`\x1b[${colors[method]}m[${fileLevel[method]}]\x1b[0m ${entry.trim()}`);
    };
  }
}

const Logger = {
  log: (...args) => console.log(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => console.debug(...args),
};

module.exports = Logger;
