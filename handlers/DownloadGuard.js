/**
 * DownloadGuard — el bot NUNCA debe descargar audio a disco.
 *
 * El audio se reproduce leyendo la URL del stream directamente con ffmpeg; yt-dlp
 * solo se usa para consultar (buscar, validar, resolver la URL del stream). Aun
 * así, algunas llamadas a yt-dlp (la búsqueda de respaldo `YTSEARCH_FALLBACK`,
 * por ejemplo) pasaban opciones de formato SIN pedirle explícitamente que no
 * descargara, y yt-dlp terminaba escribiendo `Titulo [id].m4a` en la carpeta del
 * bot.
 *
 * Este módulo cubre el problema en la raíz, sin depender de que cada llamada
 * acierte con sus flags:
 *
 *   1. Intercepta child_process.spawn/execFile (+ variantes Sync). Cuando el
 *      ejecutable es yt-dlp, garantiza `--simulate --skip-download` y quita las
 *      opciones que sirven para descargar o convertir (`--no-simulate`, `-x`,
 *      `--audio-format`, `-k`...). Si un llamador pide salida a stdout (`-o -`)
 *      se deja pasar tal cual: eso no escribe archivos.
 *   2. Barre la carpeta del bot cada pocos minutos y borra restos con el patrón
 *      de yt-dlp (`Titulo [id].m4a/.mp3/.webm/.opus/.part…`), por si algún
 *      proceso externo los dejó.
 *
 * DEBE cargarse antes que cualquier módulo que use yt-dlp (primera línea de
 * index.js, tras loadEnvFile).
 */
"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const YTDLP_EXE = /(^|[\\/])yt-dlp(?:[_-][\w.]+)?(?:\.exe)?$/i;

// Opciones sin valor que implican descargar/convertir/escribir archivos.
const BAD_FLAGS = new Set([
  "--no-simulate",
  "-x", "--extract-audio",
  "-k", "--keep-video",
  "--embed-thumbnail", "--embed-metadata", "--embed-subs", "--embed-chapters",
  "--write-thumbnail", "--write-all-thumbnails",
  "--write-info-json", "--write-description", "--write-subs", "--write-auto-subs",
  "--no-part",
]);
// Opciones que llevan un valor a continuación.
const BAD_FLAGS_WITH_VALUE = new Set([
  "--audio-format", "--audio-quality", "--remux-video", "--recode-video",
  "--merge-output-format", "--postprocessor-args", "--ppa", "--exec", "--convert-thumbnails",
]);
// Si aparece alguna, el llamador no consulta nada de un video: no se toca.
const PASSTHROUGH = new Set(["--version", "-U", "--update", "--update-to", "--help", "-h", "--list-extractors", "--list-extractor-descriptions"]);

const SAFE_SAMPLE_MAX = 220;
let lastWarnAt = 0;
let interventions = 0;

function sanitizeArgs(args) {
  if (!Array.isArray(args)) return { args, changed: false, reasons: [] };
  const list = args.map(String);
  if (list.some((a) => PASSTHROUGH.has(a))) return { args, changed: false, reasons: [] };

  // `-o -` / `--output -`: stream a stdout, no escribe archivos → no se toca.
  for (let i = 0; i < list.length - 1; i++) {
    if ((list[i] === "-o" || list[i] === "--output") && list[i + 1] === "-") {
      return { args, changed: false, reasons: [] };
    }
  }

  const out = [];
  const reasons = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (BAD_FLAGS.has(a)) { reasons.push(`quitado ${a}`); continue; }
    if (BAD_FLAGS_WITH_VALUE.has(a)) { reasons.push(`quitado ${a}`); i++; continue; }
    // formas `--opcion=valor`
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0 && BAD_FLAGS_WITH_VALUE.has(a.slice(0, eq))) {
      reasons.push(`quitado ${a.slice(0, eq)}`);
      continue;
    }
    out.push(a);
  }

  // El ÚLTIMO argumento posicional suele ser la URL/consulta: los flags se
  // insertan al principio para no depender de ese orden.
  const has = (...names) => out.some((a) => names.includes(a));
  const inject = [];
  if (!has("--simulate", "-s")) { inject.push("--simulate"); reasons.push("añadido --simulate"); }
  if (!has("--skip-download", "--no-download")) { inject.push("--skip-download"); reasons.push("añadido --skip-download"); }

  const changed = reasons.length > 0;
  return { args: changed ? [...inject, ...out] : args, changed, reasons };
}

function describe(args) {
  let s = (Array.isArray(args) ? args : []).map((a) => String(a)).join(" ");
  // No volcar rutas de cookies/URLs largas al log.
  s = s.replace(/--cookies\s+\S+/g, "--cookies <…>");
  return s.length > SAFE_SAMPLE_MAX ? `${s.slice(0, SAFE_SAMPLE_MAX)}…` : s;
}

function report(file, reasons, originalArgs) {
  interventions++;
  const now = Date.now();
  // Una línea cada 30 min como máximo (el guard actúa en cada llamada que lo
  // necesita; sin tope llenaría el log).
  if (now - lastWarnAt < 30 * 60 * 1000) return;
  lastWarnAt = now;
  try {
    console.warn(
      `[DownloadGuard] yt-dlp iba a poder DESCARGAR audio (${reasons.join(", ")}). ` +
      `Se forzó solo-consulta. Total intervenciones: ${interventions}. Args originales: ${describe(originalArgs)}`
    );
  } catch {}
}

function wrap(name, argIndexFor) {
  const orig = cp[name];
  if (typeof orig !== "function" || orig.__downloadGuard) return;
  const patched = function (file, ...rest) {
    try {
      if (typeof file === "string" && YTDLP_EXE.test(file)) {
        const idx = argIndexFor(rest);
        if (idx >= 0 && Array.isArray(rest[idx])) {
          const { args, changed, reasons } = sanitizeArgs(rest[idx]);
          if (changed) {
            report(file, reasons, rest[idx]);
            rest[idx] = args;
          }
        }
      }
    } catch (_) { /* el guard jamás debe romper la ejecución */ }
    return orig.call(this, file, ...rest);
  };
  patched.__downloadGuard = true;
  // Conserva las propiedades (p. ej. util.promisify.custom de execFile).
  Object.setPrototypeOf(patched, orig);
  for (const k of Reflect.ownKeys(orig)) {
    if (["length", "name", "prototype"].includes(k)) continue;
    try { patched[k] = orig[k]; } catch {}
  }
  // util.promisify(execFile) usa una versión PROPIA copiada del original, que
  // saltaría este wrapper: se reemplaza por una que pase por `patched`.
  const custom = require("util").promisify.custom;
  if (orig[custom]) {
    Object.defineProperty(patched, custom, {
      configurable: true,
      value: (...a) =>
        new Promise((resolve, reject) => {
          const child = patched(...a, (err, stdout, stderr) => {
            if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
            else resolve({ stdout, stderr });
          });
          void child;
        }),
    });
  }
  cp[name] = patched;
}

// En spawn/spawnSync/execFile/execFileSync los args son el 2º parámetro
// (primer elemento de `rest` tras `file`) cuando son un array.
const argsFirst = (rest) => (Array.isArray(rest[0]) ? 0 : -1);

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  wrap("spawn", argsFirst);
  wrap("spawnSync", argsFirst);
  wrap("execFile", argsFirst);
  wrap("execFileSync", argsFirst);
  // Módulos ESM que importan { spawn } de "node:child_process" ven el cambio.
  try { require("module").syncBuiltinESMExports(); } catch {}
}

// ── Barrido de restos ────────────────────────────────────────────────────────
// `Titulo [dQw4w9WgXcQ].m4a`, `Titulo [id].f251.webm`, `Titulo [id].m4a.part`, …
const STRAY = /\[[A-Za-z0-9_-]{11}\]\.(?:f\d+\.)?(?:m4a|mp3|mp4|webm|opus|ogg|wav|flac|aac|mkv)(?:\.part|\.ytdl|\.temp)?$|\[[A-Za-z0-9_-]{11}\]\.(?:part|ytdl)$/i;
const MIN_AGE_MS = 15000;

function sweepStray(dir = process.cwd(), log = true) {
  let removed = 0;
  try {
    const now = Date.now();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !STRAY.test(ent.name)) continue;
      const full = path.join(dir, ent.name);
      try {
        if (now - fs.statSync(full).mtimeMs < MIN_AGE_MS) continue;
        fs.unlinkSync(full);
        removed++;
      } catch {}
    }
  } catch {}
  if (removed && log) {
    try { console.warn(`[DownloadGuard] ${removed} archivo(s) de audio descargado(s) por error fueron eliminados de ${dir}.`); } catch {}
  }
  return removed;
}

function startSweeper(intervalMs = 5 * 60 * 1000) {
  sweepStray();
  const t = setInterval(() => sweepStray(), intervalMs);
  if (typeof t.unref === "function") t.unref();
  return t;
}

install();

module.exports = { install, sanitizeArgs, sweepStray, startSweeper, STRAY };
