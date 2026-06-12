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
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, [
      "--flat-playlist", "--print", "webpage_url",
      "--no-warnings", "--js-runtimes", "node",
      playlistUrl,
    ]);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => stdout += d);
    proc.stderr.on("data", (d) => stderr += d);
    proc.on("close", () => {
      const urls = stdout.trim().split("\n").filter(Boolean);
      if (urls.length) resolve(urls);
      else reject(new Error(stderr || "No se encontraron videos"));
    });
    proc.on("error", reject);
  });
}

module.exports = {
  name: "saltaryreproducir",
  name_localizations: {
    "en-US": "skipandplay",
    "en-GB": "skipandplay",
  },
  description: `Salta la canción actual y reproduce una nueva`,
  description_localizations: {
    "en-US": "Skip current song and play a new one",
    "en-GB": "Skip current song and play a new one",
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
      description: "La canción que quieres reproducir",
      description_localizations: {
        "en-US": "The name or link of the song/playlist",
        "en-GB": "The name or link of the song/playlist",
      },
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],

  /**
   *
   * @param {JUGNU} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
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
      skip: true,
      ...(hqMode ? { volume: 100 } : {}),
    };

    const isURL = /^https?:\/\//i.test(song);

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
        client.logger.log(`[Playlist Skip] Playlist cargada: ${urls.length} tracks`);
      } catch (e) {
        client.logger.error("[Playlist Skip Error]", e);
        return interaction.followUp({
          content: `❌ No se pudo cargar la playlist: ${e.message}`,
          ephemeral: true,
        });
      }

      try { await client.distube.voices.join(channel); } catch {}

      // Encola primer track y salta actual
      let queue;
      try {
        queue = await client.distube.play(channel, urls[0], playOpts);
        queue._sessionSaved = true;
        queue._sessionSourcePlaylist = true;
      } catch (e) {
        client.logger.error("[Playlist Skip Track 1 Error]", e);
        return interaction.followUp({
          content: `❌ Error en el primer track: ${e.message}`,
          ephemeral: true,
        });
      }

      // Resto en background secuencialmente para mayor respuesta a instrucciones
      const nextPlayOpts = { ...playOpts, skip: false };
      client.playlistLoading.set(interaction.guildId, true);
      (async () => {
        const remaining = urls.slice(1);
        let processedCount = 1;
        try {
          for (let i = 0; i < remaining.length; i++) {
            if (!client.playlistLoading.get(interaction.guildId)) break;
            const url = remaining[i];
            try {
              await client.distube.play(channel, url, nextPlayOpts);
              processedCount++;
            } catch (e) {
              client.logger.warn(`[Playlist Skip] Track ${i + 2} saltado en Guild ${interaction.guildId}:`, e.message);
            }

            // Actualizar progreso cada 5 canciones o al final
            if (processedCount % 5 === 0 || i === remaining.length - 1) {
              await interaction.editReply({ 
                content: `⏳ Procesando lista: \`${processedCount}/${urls.length}\` canciones cargadas...` 
              }).catch(() => {});
            }

            // Tiempo de espera para procesar interacciones
            await new Promise((r) => setTimeout(r, 250));
          }

          if (queue && queue.repeatMode === 2) {
            client.logger.log(`[Playlist Skip] Queue loop is active (repeatMode: 2) in Guild ${interaction.guildId}. New items included.`);
          }

          await interaction.editReply({ 
            content: `✅ Lista cargada exitosamente: \`${processedCount}/${urls.length}\` canciones procesadas.` 
          }).catch(() => {});

          if (
            queue &&
            typeof client.createMusicSession === "function" &&
            typeof client.saveMusicSession === "function"
          ) {
            try {
              const session = client.createMusicSession(queue, "playlist", undefined, song, interaction.user, queue.songs);
              await client.saveMusicSession(interaction.guildId, session);
              client.logger.log(`[Playlist Skip] Playlist session guardada: ${queue.songs.length} canciones`);
            } catch (e) {
              client.logger.error(`[Playlist Skip] Error guardando sesión de playlist:`, e);
            }
          }
          client.logger.log(`[Playlist Skip] ${urls.length} tracks procesados en Guild: ${interaction.guildId}`);
        } catch (e) {
          client.logger.error(`[Playlist Skip] Error en background loading:`, e);
        } finally {
          client.playlistLoading.delete(interaction.guildId);
        }
      })();

      return;
    }

    // --- Canción normal ---
    try {
      await client.distube.voices.join(channel);
      client.logger.log(`[Slash PlaySkip] User: ${interaction.user.tag} Guild: ${interaction.guildId} Query: ${song}`);
    } catch (e) {
      client.logger.error(`[Slash PlaySkip Join Error] Guild: ${interaction.guildId}`, e);
    }

    const query = song;

    try {
      await client.distube.play(channel, query, playOpts);
      client.logger.log(`[Slash PlaySkip Success] Guild: ${interaction.guildId} Query: ${song}`);
    } catch (e) {
      client.logger.error(`[Slash PlaySkip Error] Guild: ${interaction.guildId} Query: ${song}`, e);
      return interaction.followUp({
        content: `❌ Error: ${e.message}`,
        ephemeral: true,
      });
    }

    interaction.followUp({
      content: `🔍 Buscando \`${song}\` y saltando la actual...`,
      ephemeral: true,
    }).then((msg) => setTimeout(() => msg.delete().catch(() => {}), 3000));
  },
};
