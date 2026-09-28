const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const UserHistory = require("../../../handlers/UserHistory");
const { isAgeGateError, friendlyPlaybackError } = require("../../../handlers/PlaybackError");
const { searchYoutube } = require("../../../handlers/PlaylistFetcher");
const { streamPlaylist } = require("../../../handlers/PlaylistLoader");

const YTDLP_PATH = path.join(
  process.cwd(),
  "node_modules/@distube/yt-dlp/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

function isPlaylistURL(url) {
  return /youtube\.com\/playlist\?list=/.test(url) || /[?&]list=/.test(url);
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
        // Conserva el list si viene de una playlist (watch?v=X&list=Y&index=N)
        const list = search.get("list");
        const t = search.get("t") || search.get("start");
        let out = `https://www.youtube.com/watch?v=${v}`;
        if (list) out += `&list=${list}`;
        if (t) out += `&t=${t}`;
        return out;
      }
      if (pathname.startsWith("/shorts/")) {
        const id = pathname.split("/")[2];
        if (!id) return url;
        const list = search.get("list");
        const t = search.get("t") || search.get("start");
        let out = `https://www.youtube.com/watch?v=${id}`;
        if (list) out += `&list=${list}`;
        if (t) out += `&t=${t}`;
        return out;
      }
    }

    if (hostname === "youtu.be") {
      const id = pathname.slice(1);
      if (!id) return url;
      const list = search.get("list");
      const t = search.get("t") || search.get("start");
      let out = `https://www.youtube.com/watch?v=${id}`;
      if (list) out += `&list=${list}`;
      if (t) out += `&t=${t}`;
      return out;
    }

    return url;
  } catch {
    return url;
  }
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
  inSameVoiceChannel: false,
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

    client.playlistStopped.delete(interaction.guildId);

    const botVoiceChannel = interaction.guild.members.me.voice.channel;
    const ownerId = process.env.OWNER_ID;
    if (
      botVoiceChannel &&
      channel &&
      !botVoiceChannel.equals(channel) &&
      (!ownerId || interaction.user.id !== ownerId)
    ) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR} El bot está reproduciendo en ${botVoiceChannel}. Solo el dueño puede moverlo a su canal.`
      );
    }
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
        }).then(() => client.scheduleDelete(interaction)).catch(() => {});
      } catch (e) {}

      let playlistName = song;
      try {
        const title = await fetchPlaylistTitle(song);
        if (title) playlistName = title;
      } catch (e) {
        client.logger.warn(`[Slash Play] No se pudo obtener el título de la playlist:`, e.message);
      }

      // Reproduce la primera canción apenas se resuelve su URL y carga el resto por tandas.
      const { matchedCount: loadedCount, firstPlayed, urls } = await streamPlaylist({
        client,
        channel,
        playlistUrl: song,
        playOpts,
        onStatus: async (msg) => {
          try { await interaction.editReply({ content: msg }).catch(() => {}); } catch {}
        },
      });

      if (!firstPlayed) {
        client.logger.error("[Slash Play First Track Error] No se pudo iniciar la reproducción de la playlist.");
        try {
          await interaction.followUp({
            content: `❌ Error en el primer track reproducible.`,
            ephemeral: true,
          });
        } catch (err) {}
        client.scheduleDelete(interaction);
        return;
      }

      // Guardar sesión y registrar historial al completar la carga.
      const queue = client.distube.getQueue(interaction.guildId);
      if (queue) {
        queue._sessionSaved = true;
        queue._sessionSourcePlaylist = true;
      }

      await interaction.editReply({
        content: `✅ Lista cargada exitosamente: \`${loadedCount}/${urls.length}\` canciones procesadas.`
      }).then(() => client.scheduleDelete(interaction)).catch(() => {});

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
          client, interaction.guildId, interaction.user.id, song, playlistName, interaction.channel.id
        );
      } catch (e) {
        client.logger.error(`[Slash Play] Error recording playlist history:`, e);
      }

      client.logger.log(`[Slash Play] ${urls.length} tracks procesados en Guild: ${interaction.guildId}`);
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
        }).then(() => client.scheduleDelete(interaction)).catch(() => {});
      } catch (err) {}
      // Limpiar el efímero "🔍 Procesando..." ya confirmada la reproducción.
      client.scheduleDelete(interaction);
    } catch (e) {
      client.logger.error(`[Slash Play Error] Guild: ${interaction.guildId} Query: ${song}`, e);
      // Search failed (common when YouTube blocks the search API / missing cookies).
      // Fall back to a yt-dlp based search so text queries still work.
      if (!isURL) {
        try {
          const resolved = await searchYoutube(song);
          if (resolved) {
            await client.distube.voices.join(channel);
            await client.distube.play(channel, resolved, playOpts);
            client.logger.log(`[Slash Play] yt-dlp fallback OK: ${resolved}`);
            try {
              if (interaction.deferred || interaction.replied) await interaction.followUp({ content: `✅ Reproduciendo \`${song.slice(0, 70)}\``, ephemeral: true }).then(() => client.scheduleDelete(interaction)).catch(() => {});
              client.scheduleDelete(interaction);
            } catch (err) {}
            return;
          }
        } catch (e2) {
          client.logger.error(`[Slash Play] yt-dlp fallback error:`, e2);
        }
      }
      const errorMsg = { 
        content: isAgeGateError(e) ? friendlyPlaybackError(e) : `❌ No se pudo reproducir: ${e.message.slice(0, 100)}`,
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
      // Limpiar el efímero "🔍 Procesando..." (el error queda como followUp aparte).
      client.scheduleDelete(interaction);
    }
  },
};