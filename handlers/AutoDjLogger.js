/**
 * Log SEPARADO de las decisiones del AutoDJ.
 *
 * Escribe a `logs/autodj.log` (una línea JSON por decisión) para poder auditar
 * después por qué sonó cada canción: origen (recomendación de un usuario vs
 * aleatoria), 👍/👎, reproducciones totales y de la sesión, skips, peso y el
 * tamaño de los pools/candidatas en ese momento.
 *
 * Es independiente del Logger global (que sigue escribiendo logs.txt).
 */
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "autodj.log");
const BACKUP_FILE = `${LOG_FILE}.1`;
const MAX_BYTES = Math.max(1, Number(process.env.AUTODJ_LOG_MAX_MB) || 8) * 1024 * 1024;

let bytes = 0;
let pending = [];
let flushTimer = null;

try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  if (fs.existsSync(LOG_FILE)) bytes = fs.statSync(LOG_FILE).size;
} catch (_) {}

function rotate(nextLen) {
  if (bytes + nextLen <= MAX_BYTES) return;
  try { fs.rmSync(BACKUP_FILE, { force: true }); } catch (_) {}
  try { fs.renameSync(LOG_FILE, BACKUP_FILE); } catch (_) {}
  bytes = 0;
}

function flush() {
  flushTimer = null;
  if (pending.length === 0) return;
  const chunk = pending.join("");
  pending = [];
  try {
    rotate(Buffer.byteLength(chunk));
    fs.appendFileSync(LOG_FILE, chunk);
    bytes += Buffer.byteLength(chunk);
  } catch (_) {}
}

function enqueue(line) {
  pending.push(line);
  if (pending.length >= 100) return flush();
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
  if (flushTimer.unref) flushTimer.unref();
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Registra una decisión del AutoDJ.
 * @param {Object} entry - datos libres (guildId, type, url, name, ...).
 * @param {string} [tag] - etiqueta corta (p.ej. "pick", "summary", "empty").
 */
function decision(entry, tag = "pick") {
  try {
    enqueue(`[${ts()}] [${tag}] ${JSON.stringify(entry)}\n`);
  } catch (_) {}
}

/** Fuerza el volcado pendiente (p.ej. antes de salir). */
function flushNow() { flush(); }

module.exports = { decision, flushNow, LOG_FILE };
