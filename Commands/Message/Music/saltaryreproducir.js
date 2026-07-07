const { Message, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");
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

module.exports = {
  name: "saltaryreproducir",
  aliases: ["ps", "pskip", "skipandplay"],
  description: `Salta la canción actual y reproduce una nueva`,
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: false,
  djOnly: false,

  /**
   *
   * @param {JUGNU} client
   * @param {Message} message
   * @param {String[]} args
   * @param {String} prefix
   * @param {Queue} queue
   */
  run: async (client, message, args, prefix, queue) => {
    const song = args.join(" ");

    if (!song) {
      return client.embed(message, `${client.config.emoji.ERROR} Proporciona una canción.`);
    }

    let { channel } = message.member.voice;
    const hqStored = await client.music.get(`${message.guildId}.hqmode`);
    const hqMode = (hqStored === undefined ? process.env.HQ_MODE === "true" : hqStored) || false;
    
    const playOpts = {
      member: message.member,
      textChannel: message.channel,
      message: message,
      skip: true,
      ...(hqMode ? { volume: 100 } : {}),
    };

    const isURL = /^(https?:\/\/)/i.test(song);

    // --- Playlist ---
    if (isURL && isPlaylistURL(song)) {
      const statusMsg = await client.embed(message, `⏳ Obteniendo playlist...`);
      let urls;
      try {
        urls = await fetchPlaylistURLs(song);
      } catch (e) {
        return client.embed(message, `${client.config.emoji.ERROR} No se pudo cargar: ${e.message}`);
      }

      try { await client.distube.voices.join(channel); } catch {}

      let addedCount = 0;
      try {
        await client.distube.play(channel, urls[0], playOpts);
        addedCount++;
      } catch (e) {
        client.logger.warn(`[PlaySkip Msg] Primer track falló.`);
      }

      const nextPlayOpts = { ...playOpts, skip: false };
      client.playlistLoading.set(message.guildId, true);
      (async () => {
        const remaining = urls.slice(1);
        for (let i = 0; i < remaining.length; i++) {
          if (!client.playlistLoading.get(message.guildId)) break;
          try {
            await client.distube.play(channel, remaining[i], nextPlayOpts);
            addedCount++;
          } catch (e) {}

          if (addedCount % 5 === 0 || i === remaining.length - 1) {
            if (statusMsg && statusMsg.edit) {
              statusMsg.edit({
                embeds: [
                  new EmbedBuilder()
                    .setColor(client.config.embed.color)
                    .setDescription(`⏳ Procesando lista: \`${addedCount}/${urls.length}\` canciones cargadas y saltando la actual...`)
                    .setFooter(client.getFooter(message.author)),
                ],
              }).catch(() => {});
            }
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        
        if (statusMsg && statusMsg.edit) {
          statusMsg.edit({
            embeds: [
              new EmbedBuilder()
                .setColor(client.config.embed.color)
                .setDescription(`✅ Lista cargada exitosamente: \`${addedCount}/${urls.length}\` canciones procesadas.`)
                .setFooter(client.getFooter(message.author)),
            ],
          }).catch(() => {});
        }
        client.playlistLoading.delete(message.guildId);
      })();
      return;
    }

    // --- Normal ---
    try {
      await client.distube.voices.join(channel);
      const query = isURL ? song : `ytsearch1:${song}`;
      await client.distube.play(channel, query, playOpts);
      await message.delete().catch(() => {});
    } catch (e) {
      client.embed(message, `${client.config.emoji.ERROR} Error: ${e.message}`);
    }
  },
};
