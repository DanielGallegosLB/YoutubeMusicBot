const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const YTDLP_PATH = path.join(
  process.cwd(),
  "node_modules/@distube/yt-dlp/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

function isPlaylistURL(url) {
  if (typeof url !== "string" || !url) return false;
  // Playlists de YouTube
  if (/youtube\.com\/playlist\?list=/.test(url)) return true;
  if (/[?&]list=/.test(url) && !/watch\?v=/.test(url)) return true;
  // Sets de SoundCloud ("/sets/") y álbumes/sets de otros sitios: son LOTE,
  // no singles. (*/#chud era un set que el pool tomaba como single y play()
  // se colgaba resolviéndolo.)
  if (/soundcloud\.com\/[^/]+\/sets\//i.test(url)) return true;
  if (/\/(albums?|sets|playlists?)\//i.test(url) && !/watch\?v=/.test(url)) return true;
  return false;
}

function buildArgs(playlistUrl, startItem, endItem, extraPrints = []) {
  const cookiePath = path.join(process.cwd(), "yt-cookies.txt");
  const args = [
    "--flat-playlist",
    "--print", "webpage_url",
    ...extraPrints,
    "--no-warnings",
    "--ignore-errors",
    "--no-check-certificates",
    "--js-runtimes", "node",
    "--playlist-items", `${startItem}-${endItem}`,
    playlistUrl,
  ];
  if (fs.existsSync(cookiePath)) {
    args.push("--cookies", cookiePath);
  }
  return args;
}

function runYtDlp(args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, args);
    let stdout = "", stderr = "";
    let done = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            // El proceso no responde: matarlo para no colgar a su llamador.
            try { proc.kill(); } catch {}
            if (!done) { done = true; reject(new Error(`yt-dlp timeout ${timeoutMs}ms`)); }
          }, timeoutMs)
        : null;
    proc.stdout.on("data", (d) => stdout += d);
    proc.stderr.on("data", (d) => stderr += d);
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (done) return;
      done = true;
      resolve({ stdout, stderr, code });
    });
    proc.on("error", (e) => {
      if (timer) clearTimeout(timer);
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

// Las validaciones corren yt-dlp (un proceso por canción). Si se lanzan muchas
// a la vez (NextValidator + refill + reconexión) se saturan la red/CPU y todas
// se vuelven lentas -> timeouts masivos. Se SERIALIZAN en una cola: máximo 1
// yt-dlp de validación a la vez.
let _validationChain = Promise.resolve();
const serializeValidation = (fn) => {
  const run = _validationChain.then(fn);
  _validationChain = run.then(() => {}, () => {});
  return run;
};

/**
 * Fetch ONLY the first track URL of a playlist. Fast (~seconds), used to
 * start playback immediately while the rest is fetched in the background.
 * @param {string} playlistUrl
 * @returns {Promise<string|null>}
 */
function fetchPlaylistFirstURL(playlistUrl, opts = {}) {
  return serializeValidation(() =>
    new Promise(async (resolve) => {
      try {
        const timeoutMs = opts.timeoutMs || 0;
        const { stdout, stderr } = await runYtDlp(buildArgs(playlistUrl, 1, 1), timeoutMs);
        const url = stdout.trim().split("\n").find(Boolean);
        if (!url) console.error(`[fetchPlaylistFirstURL] Empty result for ${playlistUrl}\n${stderr.trim().slice(0, 500)}`);
        resolve(url || null);
      } catch (e) {
        if (/timeout/i.test(e?.message || "")) console.error(`[fetchPlaylistFirstURL] Timeout (${opts.timeoutMs}ms) for ${playlistUrl}`);
        else console.error("[fetchPlaylistFirstURL] Error:", e);
        resolve(null);
      }
    })
  );
}

/**
 * Fetch playlist URLs in chunks so the caller can start playback with the
 * first URLs immediately instead of waiting for the whole playlist.
 * Calls onBatch(urls, isLastChunk) for each chunk (first chunk -> rest), and
 * resolves with the complete dedup list at the end.
 * If onBatch returns `false`, streaming is aborted early.
 * @param {string} playlistUrl
 * @param {(urls: string[], isLastChunk: boolean) => void|boolean|Promise<void|boolean>} onBatch
 * @param {{ startItem?: number, batchSize?: number, maxItems?: number }} [opts]
 * @returns {Promise<string[]>}
 */
function fetchPlaylistURLsIncrementally(playlistUrl, onBatch, opts = {}) {
  const startItem = opts.startItem || 1;
  const batchSize = opts.batchSize || 100;
  const maxItems = opts.maxItems || 1000;
  return new Promise(async (resolve) => {
    let allUrls = [];
    let cursor = startItem;

    while (cursor <= maxItems) {
      const endItem = cursor + batchSize - 1;
      let batchUrls = [];
      try {
        const { stdout, stderr } = await runYtDlp(buildArgs(playlistUrl, cursor, endItem));
        batchUrls = stdout.trim().split("\n").filter(Boolean);
        if (batchUrls.length === 0 && stderr) {
          console.error(`[fetchPlaylistURLs] batch ${cursor}-${endItem} vacío:\n${stderr.trim().slice(0, 500)}`);
        }
      } catch (e) {
        console.error(`[fetchPlaylistURLs] Error in batch ${cursor}:`, e);
        break;
      }

      if (batchUrls.length === 0) break;
      const freshUrls = [];
      for (const url of batchUrls) {
        if (!allUrls.includes(url)) {
          allUrls.push(url);
          freshUrls.push(url);
        }
      }
      try {
        if (typeof onBatch === "function" && freshUrls.length > 0) {
          const shouldAbort = (await onBatch(freshUrls, batchUrls.length < batchSize)) === false;
          if (shouldAbort) break;
        }
      } catch (e) {
        console.error(`[fetchPlaylistURLs] Error in onBatch ${cursor}:`, e);
        break;
      }
      if (batchUrls.length < batchSize) break;
      cursor += batchSize;
    }

    resolve(allUrls.length > 0 ? allUrls : []);
  });
}

/**
 * Lista COMPLETA de urls en UNA sola llamada flat (rápida: no resuelve cada
 * video). La usa el AutoDJ para saber las 316 desde el inicio, aunque el loader
 * todavía vaya por la 40.
 * @param {string} playlistUrl
 * @param {number} [maxItems]
 * @returns {Promise<string[]>}
 */
async function fetchPlaylistAllURLsFlat(playlistUrl, maxItems = 1000) {
  try {
    const { stdout } = await runYtDlp(buildArgs(playlistUrl, 1, maxItems));
    return [...new Set(stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch (e) {
    console.error("[fetchPlaylistAllURLsFlat] Error:", e);
    return [];
  }
}

/**
 * Valida que una URL de video suelto sea reproducible por DisTube sin colgarse:
 * corre yt-dlp con `--simulate` (trae metadata + formatos, que es justo lo que
 * suele trabajar) y devuelve un VEREDICTO:
 *   { status: "ok",     title }  -> yt-dlp resolvió el título: se puede usar
 *   { status: "invalid", reason } -> YouTube confirmó que NO existe / fue
 *                                    removido / privado / bloq. de edad
 *                                    (SOLO esto autoriza a descartar la canción)
 *   { status: "unknown", reason } -> timeout / error genérico: yt-dlp estaba
 *                                    lento o se cortó la red, NO sabemos si la
 *                                    canción es mala -> el llamador la CONSERVA
 * Las validaciones se serializan (1 yt-dlp a la vez) para no saturar la red.
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{status:string, title?:string, reason?:string}>}
 */
async function validateSinglePlayable(url, timeoutMs = 15000) {
  return serializeValidation(async () => {
    const cookiePath = path.join(process.cwd(), "yt-cookies.txt");
    const args = [
      "--no-playlist",
      "--simulate",
      "--print", "title",
      "--no-warnings",
      "--ignore-errors",
      "--no-check-certificates",
      "--js-runtimes", "node",
      url,
    ];
    if (fs.existsSync(cookiePath)) args.push("--cookies", cookiePath);
    try {
      const { stdout, stderr } = await runYtDlp(args, timeoutMs);
      const title = stdout.trim().split("\n").find(Boolean);
      if (title) return { status: "ok", title };
      const evidence = (stderr + "\n" + stdout).slice(0, 600);
      if (/removed for violating|has been removed|removed|Private video|Video unavailable|not available|doesn't exist|does not exist|sign in to confirm|members-only|age.?restricted|this video is unavailable|forbidden|YouTube said|Extractor error/i.test(evidence)) {
        return { status: "invalid", reason: evidence.replace(/\s+/g, " ").trim().slice(0, 220) || "indisponible en YouTube" };
      }
      return { status: "unknown", reason: evidence.replace(/\s+/g, " ").trim().slice(0, 220) || "salida vacía" };
    } catch (e) {
      if (/timeout/i.test(e?.message || "")) {
        console.error(`[validateSinglePlayable] Timeout (${timeoutMs}ms) para ${url} → hay una cola de validaciones: yt-dlp está lento, se conserva la canción.`);
        return { status: "unknown", reason: `timeout ${timeoutMs}ms` };
      }
      return { status: "unknown", reason: (e?.message || e).toString().slice(0, 220) };
    }
  });
}

/**
 * @param {string} playlistUrl
 * @returns {Promise<string[]>}
 */
function fetchPlaylistURLs(playlistUrl) {
  return fetchPlaylistURLsIncrementally(playlistUrl, null);
}

/**
 * Search YouTube via yt-dlp and return the first result as a watch URL.
 * Falls back gracefully — returns null if nothing is found.
 * @param {string} query
 * @returns {Promise<string|null>}
 */
function searchYoutube(query) {
  return new Promise((resolve) => {
    const cookiePath = path.join(process.cwd(), "yt-cookies.txt");
    const args = [
      "--default-search", "ytsearch1",
      "--playlist-items", "1-1",
      "--print", "webpage_url",
      "--no-warnings",
      "--ignore-errors",
      "--no-check-certificates",
      "--js-runtimes", "node",
      query,
    ];
    if (fs.existsSync(cookiePath)) {
      args.push("--cookies", cookiePath);
    }
    const proc = spawn(YTDLP_PATH, args);
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const url = stdout.trim().split("\n").find(Boolean);
      resolve(url || null);
    });
  });
}

module.exports = { YTDLP_PATH, isPlaylistURL, fetchPlaylistURLs, fetchPlaylistAllURLsFlat, fetchPlaylistURLsIncrementally, fetchPlaylistFirstURL, validateSinglePlayable, searchYoutube };