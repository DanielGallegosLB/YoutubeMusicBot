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

module.exports = { YTDLP_PATH, isPlaylistURL, fetchPlaylistURLs };
