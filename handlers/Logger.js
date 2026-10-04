const fs = require("fs");
const path = require("path");
const { format } = require("util");

const logFile = path.join(process.cwd(), "logs.txt");
const backupFile = `${logFile}.1`;

// Tope del archivo: al llegar se rota (logs.txt -> logs.txt.1) y se sigue.
// Antes logs.txt llegó a 41 MB (33 MB solo de spam de ffmpeg) sin rollover.
const MAX_BYTES = Math.max(1, Number(process.env.LOG_MAX_MB) || 8) * 1024 * 1024;
// Espejo en la consola. Se puede apagar con LOG_CONSOLE=0: en Windows, una
// consola con miles de líneas por segundo (y el usuario haciendo scroll o
// seleccionando texto) BLOQUEA la escritura y con ella TODO el event loop del
// bot: el audio se corta y no vuelve hasta que se release la selección.
const MIRROR_CONSOLE = process.env.LOG_CONSOLE !== "0";
const MAX_ENTRY_CHARS = 2000;

function getTimestamp() {
  const now = new Date();
  const pad = (n, d = 2) => String(n).padStart(d, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

// ---- Escritura a disco ASÍNCRONA y agrupada -------------------------------
// Antes CADA línea llamaba fs.appendFileSync (abrir+escribir+cerrar) en el event
// loop. Con el volumen de log de este bot (cientos de miles de líneas) el
// proceso se pasaba segundos con el loop bloqueado: los timers del watchdog no
// disparaban y los timeouts de yt-dlp se atrasaban. Ahora las entradas se
// acumulan y se descargan cada ~1s (o cada 200 líneas) con appendFile async.
let pending = [];
let flushTimer = null;
let bytesWritten = 0;
let flushing = false;
try {
  bytesWritten = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
} catch {}

function rotateIfNeeded(chunkLength) {
  if (bytesWritten + chunkLength <= MAX_BYTES) return;
  try { fs.rmSync(backupFile, { force: true }); } catch {}
  try { fs.renameSync(logFile, backupFile); } catch {}
  bytesWritten = 0;
}

function flushSync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.length) return;
  const chunk = pending.join("");
  pending = [];
  try {
    rotateIfNeeded(chunk.length);
    fs.appendFileSync(logFile, chunk);
    bytesWritten += chunk.length;
  } catch {}
}

// Tamaño máximo de cada appendFile. Si el event loop se bloquea (y se acumulan
// muchas entradas), el volcado se hace en porciones: así la rotación puede
// actuar y el archivo nunca queda muy por encima del tope.
const SLICE_BYTES = 256 * 1024;

function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.length || flushing) return;
  flushing = true;
  let len = 0;
  let i = 0;
  while (i < pending.length && len < SLICE_BYTES) len += pending[i++].length;
  const chunk = pending.slice(0, i).join("");
  pending = pending.slice(i);
  // La rotación DEBE ocurrir con ninguna escritura async en vuelo: si no, el
  // rename/rmSync puede borrar un backup al que un appendFile anterior todavía
  // está escribiendo y se pierden esas líneas.
  try {
    rotateIfNeeded(len);
  } catch {}
  const done = () => {
    flushing = false;
    try { bytesWritten += len; } catch {}
    if (pending.length) flush();
  };
  try {
    fs.appendFile(logFile, chunk, done);
  } catch {
    try { fs.writeFileSync(logFile, chunk); } catch {}
    done();
  }
}

const queue = (entry) => {
  pending.push(entry);
  if (pending.length >= 200) return flush();
  if (!flushTimer) {
    flushTimer = setTimeout(flush, 1000);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }
};

// Última chance de volcar lo pendiente antes de morir.
process.on("exit", () => {
  if (flushTimer) clearTimeout(flushTimer);
  flushSync();
});

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
      let message;
      try {
        message = format(...args);
      } catch {
        message = args.map((a) => String(a)).join(" ");
      }
      // Una sola línea por entrada (los volcados multilínea de ffmpeg/PDBG
      // rompían el formato y multiplicaban el tamaño del archivo).
      const flat = String(message).replace(/\s*\r?\n\s*/g, " ");
      const entry = `[${getTimestamp()}] [${fileLevel[method]}] ${flat}\n`;
      queue(entry);
      if (!MIRROR_CONSOLE) return;
      const shown = flat.length > MAX_ENTRY_CHARS ? `${flat.slice(0, MAX_ENTRY_CHARS)}…` : flat;
      try {
        original(`\x1b[${colors[method]}m[${fileLevel[method]}]\x1b[0m [${getTimestamp()}] ${shown}`);
      } catch {}
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
