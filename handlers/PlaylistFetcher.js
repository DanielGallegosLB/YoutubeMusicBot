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

function fetchPlaylistURLs(playlistUrl) {
  return new Promise(async (resolve) => {
    let allUrls = [];
    let startItem = 1;
    const batchSize = 100;
    const maxItems = 1000;
    const cookiePath = path.join(process.cwd(), "yt-cookies.txt");

    while (startItem <= maxItems) {
      const endItem = startItem + batchSize - 1;
      const args = [
        "--flat-playlist",
        "--print", "webpage_url",
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

      try {
        const batchUrls = await new Promise((res, rej) => {
          const proc = spawn(YTDLP_PATH, args);
          let stdout = "", stderr = "";
          proc.stdout.on("data", (d) => stdout += d);
          proc.stderr.on("data", (d) => stderr += d);
          proc.on("close", () => {
            const urls = stdout.trim().split("\n").filter(Boolean);
            res(urls);
          });
          proc.on("error", rej);
        });

        if (batchUrls.length === 0) break;
        for (const url of batchUrls) {
          if (!allUrls.includes(url)) allUrls.push(url);
        }
        if (batchUrls.length < batchSize) break;
        startItem += batchSize;
      } catch (e) {
        console.error(`[fetchPlaylistURLs] Error in batch ${startItem}:`, e);
        break;
      }
    }

    resolve(allUrls.length > 0 ? allUrls : []);
  });
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

module.exports = { YTDLP_PATH, isPlaylistURL, fetchPlaylistURLs, searchYoutube };
