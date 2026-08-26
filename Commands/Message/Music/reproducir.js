const { Message, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const UserHistory = require("../../../handlers/UserHistory");

const YTDLP_PATH = path.join(
  process.cwd(),
  "node_modules/@distube/yt-dlp/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

function isPlaylistURL(url) {
  return /youtube\.com\/playlist\?list=/.test(url) ||
    (/[?&]list=/.test(url) && !/watch\?v=/.test(url));
}

function fetchPlaylistTitle(playlistUrl) {
  return new Promise((resolve) => {
    const cookiePath = path.join(process.cwd(), "yt-cookies.txt");
    const args = [
      "--flat-playlist",
      "--playlist-items", "1-1",
      "--print", "%(playlist_title)s",
      "--no-warnings",
      "--ignore-errors",
      "--no-check-certificates",
      "--js-runtimes", "node",
      playlistUrl,
    ];
    if (fs.existsSync(cookiePath)) {
      args.push("--cookies", cookiePath);
    }
    const proc = spawn(YTDLP_PATH, args);
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.on("error", () => resolve(""));
    proc.on("close", () => {
      const title = stdout.trim().split("\n")[0];
      resolve(title || "");
    });
  });
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
  name: "reproducir",
  aliases: ["p", "song", "play"],
  description: `Reproduce una canción o lista`,
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  inVoiceChannel: true,
  inSameVoiceChannel: false,
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

    client.playlistStopped.delete(message.guildId);

    let { channel } = message.member.voice;

    const botVoiceChannel = message.guild.members.me.voice.channel;
    const ownerId = process.env.OWNER_ID;
    if (
      botVoiceChannel &&
      channel &&
      !botVoiceChannel.equals(channel) &&
      (!ownerId || message.author.id !== ownerId)
    ) {
      return client.embed(
        message,
        `${client.config.emoji.ERROR} El bot está reproduciendo en ${botVoiceChannel}. Solo el dueño puede moverlo a su canal.`
      );
    }

    const hqStored = await client.music.get(`${message.guildId}.hqmode`);
    const hqMode = (hqStored === undefined ? process.env.HQ_MODE === "true" : hqStored) || false;
    
    const playOpts = {
      member: message.member,
      textChannel: message.channel,
      message: message,
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

      let playlistName = song;
      try {
        const title = await fetchPlaylistTitle(song);
        if (title) playlistName = title;
      } catch (e) {
        client.logger.warn(`[Play Msg] No se pudo obtener el título de la playlist:`, e.message);
      }

      try { await client.distube.voices.join(channel); } catch {}

      let addedCount = 0;
      try {
        await client.distube.play(channel, urls[0], playOpts);
        addedCount++;
      } catch (e) {
        client.logger.warn(`[Play Msg] Primer track falló.`);
      }

      client.playlistLoading.set(message.guildId, true);
      (async () => {
        const remaining = urls.slice(1);
        for (let i = 0; i < remaining.length; i++) {
          if (!client.playlistLoading.get(message.guildId) || client.playlistStopped.get(message.guildId)) break;
          try {
            await client.distube.play(channel, remaining[i], { ...playOpts, skip: false });
            addedCount++;
          } catch (e) {}

          // Re-check after play — stop may have been pressed during await
          if (!client.playlistLoading.get(message.guildId) || client.playlistStopped.get(message.guildId)) {
            // Stop was pressed while play() was resolving — kill the new queue
            try {
              const q = client.distube.getQueue(message.guildId);
              if (q) { q.songs = []; await q.stop().catch(() => {}); }
            } catch {}
            break;
          }

          if (addedCount % 5 === 0 || i === remaining.length - 1) {
            if (statusMsg && statusMsg.edit) {
              statusMsg.edit({
                embeds: [
                  new EmbedBuilder()
                    .setColor(client.config.embed.color)
                    .setDescription(`⏳ Procesando lista: \`${addedCount}/${urls.length}\` canciones cargadas...`)
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

        // Record playlist in user's history
        try {
          await UserHistory.recordPlaylistPlay(
            client, message.guildId, message.author.id, song, playlistName, message.channel.id
          );
        } catch (e) {
          client.logger.error(`[Play Msg] Error recording playlist history:`, e);
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
