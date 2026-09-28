const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const YTDLP_PATH = path.join(
  process.cwd(),
  "node_modules/@distube/yt-dlp/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

function isPlaylistURL(url) {
  return /youtube\.com\/playlist\?list=/.test(url) ||
    (/[?&]list=/.test(url) && !/watch\?v=/.test(url));
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

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, args);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => stdout += d);
    proc.stderr.on("data", (d) => stderr += d);
    proc.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
    proc.on("error", reject);
  });
}

/**
 * Fetch ONLY the first track URL of a playlist. Fast (~seconds), used to
 * start playback immediately while the rest is fetched in the background.
 * @param {string} playlistUrl
 * @returns {Promise<string|null>}
 */
function fetchPlaylistFirstURL(playlistUrl) {
  return new Promise(async (resolve) => {
    try {
      const { stdout, stderr } = await runYtDlp(buildArgs(playlistUrl, 1, 1));
      const url = stdout.trim().split("\n").find(Boolean);
      if (!url) console.error(`[fetchPlaylistFirstURL] Empty result for ${playlistUrl}\n${stderr.trim().slice(0, 500)}`);
      resolve(url || null);
    } catch (e) {
      console.error("[fetchPlaylistFirstURL] Error:", e);
      resolve(null);
    }
  });
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

module.exports = { YTDLP_PATH, isPlaylistURL, fetchPlaylistURLs, fetchPlaylistURLsIncrementally, fetchPlaylistFirstURL, searchYoutube };