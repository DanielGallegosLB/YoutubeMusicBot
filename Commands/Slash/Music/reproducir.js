const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
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

function sanitizeYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    const search = parsed.searchParams;

    if (hostname.endsWith("youtube.com")) {
      if (pathname === "/watch") {
        const v = search.get("v");
        if (!v) return url;
        // Si tiene watch?v=X&list=Y, ignora el list (es una canción, no una playlist)
        const t = search.get("t") || search.get("start");
        let out = `https://www.youtube.com/watch?v=${v}`;
        if (t) out += `&t=${t}`;
        return out;
      }
      if (pathname.startsWith("/shorts/")) {
        const id = pathname.split("/")[2];
        if (!id) return url;
        const t = search.get("t") || search.get("start");
        let out = `https://www.youtube.com/watch?v=${id}`;
        if (t) out += `&t=${t}`;
        return out;
      }
    }

    if (hostname === "youtu.be") {
      const id = pathname.slice(1);
      if (!id) return url;
      const t = search.get("t") || search.get("start");
      let out = `https://www.youtube.com/watch?v=${id}`;
      if (t) out += `&t=${t}`;
      return out;
    }

    return url;
  } catch {
    return url;
  }
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
        
        // Add only unique URLs to avoid duplicates if YouTube overlaps
        for (const url of batchUrls) {
          if (!allUrls.includes(url)) allUrls.push(url);
        }

        // If we got fewer items than requested, we reached the end
        if (batchUrls.length < batchSize) break;
        
        startItem += batchSize;
      } catch (e) {
        console.error(`[fetchPlaylistURLs] Error in batch ${startItem}:`, e);
        break;
      }
    }

    if (allUrls.length > 0) resolve(allUrls);
    else resolve([]);
  });
}

async function playFirstAvailableTrack(client, channel, urls, playOpts) {
  for (let index = 0; index < urls.length; index++) {
    const url = urls[index];
    try {
      await client.distube.play(channel, url, playOpts);
      const queue = client.distube.getQueue(channel.guild.id);
      if (!queue) {
        throw new Error("No se pudo obtener la cola después de iniciar la reproducción.");
      }
      return { index, queue };
    } catch (e) {
      client.logger.warn(`[Slash Play] Track ${index + 1} no disponible, saltando: ${url}`, e.message);
      if (index === urls.length - 1) throw e;
    }
  }
  throw new Error("No se encontró ningún track reproducible en la playlist.");
}

module.exports = {
  name: "reproducir",
  name_localizations: {
    "en-US": "play",
    "en-GB": "play",
  },
  description: `Reproduce una canción o lista de reproducción`,
  description_localizations: {
    "en-US": "Play a song or playlist",
    "en-GB": "Play a song or playlist",
  },
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: false,
  djOnly: false,
  options: [
    {
      name: "cancion",
      name_localizations: {
        "en-US": "song",
        "en-GB": "song",
      },
      description: "El nombre o enlace de la canción/lista",
      description_localizations: {
        "en-US": "The name or link of the song/playlist",
        "en-GB": "The name or link of the song/playlist",
      },
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],

  run: async (client, interaction, args, queue) => {
    let song = interaction.options.getString("cancion");
    let { channel } = interaction.member.voice;
    if (/^https?:\/\//i.test(song)) song = sanitizeYouTubeUrl(song);
    const hqStored = await client.music.get(`${interaction.guildId}.hqmode`);
    const hqMode =
      (hqStored === undefined ? process.env.HQ_MODE === "true" : hqStored) || false;
    
    const playOpts = {
      member: interaction.member,
      textChannel: interaction.channel,
      selfDeaf: true,
      ...(hqMode ? { volume: 100 } : {}),
    };

    const isURL = /^https?:\/\//i.test(song);

    client.logger.log(`[Slash Play] User: ${interaction.user.tag} Guild: ${interaction.guildId} Query: ${song}`);

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: `🔍 Procesando \`${song.slice(0, 50)}\`...`, ephemeral: true }).catch(() => {});
      } else {
        await interaction.editReply({ content: `🔍 Procesando \`${song.slice(0, 50)}\`...` }).catch(() => {});
      }
    } catch (e) {}

    // --- Playlist ---
    if (isURL && isPlaylistURL(song)) {
      try {
        await interaction.followUp({
          content: `⏳ Obteniendo playlist...`,
          ephemeral: true,
        });
      } catch (e) {}

      let urls;
      try {
        urls = await fetchPlaylistURLs(song);
        client.logger.log(`[Slash Play] Playlist cargada: ${urls.length} tracks`);
      } catch (e) {
        client.logger.error("[Slash Play Playlist Error]", e);
        try {
          await interaction.followUp({
            content: `❌ No se pudo cargar la playlist: ${e.message}`,
            ephemeral: true,
          });
        } catch (err) {}
        return;
      }

      try { await client.distube.voices.join(channel); } catch {}

      // Toca el primer track reproducible y salta los inválidos
      let firstPlayedIndex;
      let queue;
      try {
        const result = await playFirstAvailableTrack(client, channel, urls, playOpts);
        firstPlayedIndex = result.index;
        queue = result.queue;
        queue._sessionSaved = true;
        queue._sessionSourcePlaylist = true;
        client.logger.log(`[Slash Play Success] First playable track index ${firstPlayedIndex + 1}: ${urls[firstPlayedIndex]}`);
      } catch (e) {
        client.logger.error("[Slash Play First Track Error]", e);
        try {
          await interaction.followUp({
            content: `❌ Error en el primer track reproducible: ${e.message}`,
            ephemeral: true,
          });
        } catch (err) {}
        return;
      }

      // Resto en background uno por uno con espera para mayor respuesta a instrucciones
      const nextPlayOpts = { ...playOpts, skip: false };
      client.playlistLoading.set(interaction.guildId, true);
      (async () => {
        const remaining = urls.slice(firstPlayedIndex + 1);
        let addedCount = firstPlayedIndex + 1;
        try {
          for (let i = 0; i < remaining.length; i++) {
            // Verificar si se detuvo la carga o si el bot salió
            if (!client.playlistLoading.get(interaction.guildId)) break;
            
            const url = remaining[i];
            try {
              await client.distube.play(channel, url, nextPlayOpts);
              addedCount++;
            } catch (e) {
              client.logger.warn(`[Slash Play] Track ${firstPlayedIndex + i + 2} saltado en Guild ${interaction.guildId}:`, e.message);
            }
            
            // Actualizar progreso cada 5 canciones o al final
            if (addedCount % 5 === 0 || i === remaining.length - 1) {
              await interaction.editReply({ 
                content: `⏳ Procesando lista: \`${addedCount}/${urls.length}\` canciones cargadas...` 
              }).catch(() => {});
            }

            // Tiempo de espera para que el bot procese otras instrucciones (interacciones)
            await new Promise((r) => setTimeout(r, 250));
          }

          if (queue && queue.repeatMode === 2) {
            client.logger.log(`[Playlist Load] Queue loop is active (repeatMode: 2) in Guild ${interaction.guildId}. New items included.`);
          }

          await interaction.editReply({ 
            content: `✅ Lista cargada exitosamente: \`${addedCount}/${urls.length}\` canciones procesadas.` 
          }).catch(() => {});

          if (queue && typeof client.createMusicSession === "function" && typeof client.saveMusicSession === "function") {
            try {
              const session = client.createMusicSession(
                queue,
                "playlist",
                undefined,
                song,
                interaction.user,
                queue.songs
              );
              await client.saveMusicSession(interaction.guildId, session);
              client.logger.log(`[Slash Play] Playlist session guardada: ${queue.songs.length} canciones`);
            } catch (e) {
              client.logger.error(`[Slash Play] Error guardando sesión de playlist:`, e);
            }
          }

          // Record playlist in user's history
          try {
            await UserHistory.recordPlaylistPlay(
              client, interaction.guildId, interaction.user.id, song, song, interaction.channel.id
            );
          } catch (e) {
            client.logger.error(`[Slash Play] Error recording playlist history:`, e);
          }

          client.logger.log(`[Slash Play] ${urls.length} tracks procesados en Guild: ${interaction.guildId}`);
        } catch (e) {
          client.logger.error(`[Slash Play] Error en background loading:`, e);
        } finally {
          client.playlistLoading.delete(interaction.guildId);
        }
      })();

      return;
    }

    // --- Canción normal ---
    try {
      await client.distube.voices.join(channel);
      await client.distube.play(channel, song, playOpts);
      client.logger.log(`[Slash Play Success] Guild: ${interaction.guildId} Query: ${song}`);
      try {
        await interaction.followUp({
          content: `✅ Reproduciendo \`${song.slice(0, 70)}\``,
          ephemeral: true,
        }).catch(() => {});
      } catch (err) {}
    } catch (e) {
      client.logger.error(`[Slash Play Error] Guild: ${interaction.guildId} Query: ${song}`, e);
      const errorMsg = { 
        content: `❌ No se pudo reproducir: ${e.message.slice(0, 100)}`,
        ephemeral: true 
      };
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(errorMsg).catch(() => {});
        } else {
          await interaction.reply(errorMsg).catch(() => {});
        }
      } catch (err) {
        client.logger.error(`[Slash Play Reply Error]`, err);
      }
    }
  },
};