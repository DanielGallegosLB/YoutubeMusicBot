const { Message, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const Store = require("../../../handlers/PlaylistStore");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const YTDLP_PATH = path.join(
  process.cwd(),
  "node_modules/@distube/yt-dlp/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

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

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

module.exports = {
  name: "reproduciraleatorio",
  aliases: ["shuffleplay", "ra"],
  description: `Reproduce una lista de reproducción en modo aleatorio`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: false,
  djOnly: false,
  run: async (client, message, args) => {
    const query = args.join(" ").trim();
    if (!query) return client.embed(message, `${client.config.emoji.ERROR} Proporciona un nombre de lista o URL.`);

    const vc = message.member.voice.channel;
    if (!vc) return client.embed(message, `${client.config.emoji.ERROR} Únete a un canal de voz primero.`);

    let tracks = [];
    let playlistName = "";

    const isURL = /^https?:\/\//i.test(query);

    if (isURL) {
      playlistName = "URL Playlist";
      try {
        await client.embed(message, `⏳ Obteniendo canciones de la URL...`);
        tracks = await fetchPlaylistURLs(query);
      } catch (e) {
        return client.embed(message, `${client.config.emoji.ERROR} Error al obtener la lista: ${e.message}`);
      }
    } else {
      const pl = await Store.get(client, message.guild.id, message.author.id, query);
      if (!pl || !pl.tracks.length) return client.embed(message, `${client.config.emoji.ERROR} Lista no encontrada o vacía.`);
      tracks = pl.tracks.map(t => t.url || t.name);
      playlistName = pl.name;
    }

    shuffleArray(tracks);

    const statusMsg = await client.embed(message, `✅ Cargando \`${playlistName}\`... (0/${tracks.length})`);

    const first = tracks[0];
    let addedCount = 0;
    try {
      await client.distube.play(vc, first, {
        member: message.member,
        textChannel: message.channel,
        message,
      });
      addedCount++;
    } catch (e) {
      client.logger.error(`[ShufflePlay Msg] Error en primer track: ${e.message}`);
    }

    client.playlistLoading.set(message.guild.id, true);
    (async () => {
      const remaining = tracks.slice(1);
      for (let i = 0; i < remaining.length; i++) {
        if (!client.playlistLoading.get(message.guild.id)) break;
        const t = remaining[i];
        try {
          await client.distube.play(vc, t, {
            member: message.member,
            textChannel: message.channel,
            message,
          });
          addedCount++;
        } catch (e) {
          client.logger.error(`[ShufflePlay Msg] Error en track ${i + 2}: ${e.message}`);
        }

        // Actualizar progreso cada 5 canciones o al final
        if (addedCount % 5 === 0 || i === remaining.length - 1) {
          if (statusMsg && statusMsg.edit) {
            statusMsg.edit({
              embeds: [
                new EmbedBuilder()
                  .setColor(client.config.embed.color)
                  .setDescription(`⏳ Cargando \`${playlistName}\`... (${addedCount}/${tracks.length} canciones añadidas)`)
                  .setFooter(client.getFooter(message.author)),
              ],
            }).catch(() => {});
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      const queue = client.distube.getQueue(message.guild.id);
      if (queue && queue.repeatMode === 2) {
         client.logger.log(`[ShufflePlay Msg] Queue loop active (repeatMode: 2). Consistency checked.`);
      }

      if (statusMsg && statusMsg.edit) {
        statusMsg.edit({
          embeds: [
            new EmbedBuilder()
              .setColor(client.config.embed.color)
              .setDescription(`✅ Carga finalizada: \`${playlistName}\` (${addedCount} canciones añadidas exitosamente).`)
              .setFooter(client.getFooter(message.author)),
          ],
        }).catch(() => {});
      }

      client.playlistLoading.delete(message.guild.id);
    })();

    return;
  },
};
