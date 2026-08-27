const fs = require("fs");
const path = require("path");
const { format } = require("util");

const logFile = path.join(process.cwd(), "logs.txt");

function getTimestamp() {
  const now = new Date();
  const pad = (n, d = 2) => String(n).padStart(d, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

const Logger = {
  log: (...args) => {
    const message = format(...args);
    const logEntry = `[${getTimestamp()}] [INFO] ${message}\n`;
    console.log(`\x1b[32m[INFO]\x1b[0m ${logEntry.trim()}`);
    fs.appendFileSync(logFile, logEntry);
  },
  error: (...args) => {
    const message = format(...args);
    const logEntry = `[${getTimestamp()}] [ERROR] ${message}\n`;
    console.error(`\x1b[31m[ERROR]\x1b[0m ${logEntry.trim()}`);
    fs.appendFileSync(logFile, logEntry);
  },
  warn: (...args) => {
    const message = format(...args);
    const logEntry = `[${getTimestamp()}] [WARN] ${message}\n`;
    console.warn(`\x1b[33m[WARN]\x1b[0m ${logEntry.trim()}`);
    fs.appendFileSync(logFile, logEntry);
  },
  debug: (...args) => {
    const message = format(...args);
    const logEntry = `[${getTimestamp()}] [DEBUG] ${message}\n`;
    // console.debug(`\x1b[34m[DEBUG]\x1b[0m ${logEntry.trim()}`);
    fs.appendFileSync(logFile, logEntry);
  }
};

module.exports = Logger;
