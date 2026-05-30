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
  description: `Salta la canción actual y reproduce una nueva`,
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
      description: `La canción que quieres reproducir`,
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
      try {
        await client.distube.play(channel, urls[0], playOpts);
      } catch (e) {
        client.logger.error("[Playlist Skip Track 1 Error]", e);
        return interaction.followUp({
          content: `❌ Error en el primer track: ${e.message}`,
          ephemeral: true,
        });
      }

      // Resto en background en paralelo sin skip
      const nextPlayOpts = { ...playOpts, skip: false };
      client.playlistLoading.set(interaction.guildId, true);
      (async () => {
        const promises = urls.slice(1).map((url, index) =>
          (async () => {
            if (!client.playlistLoading.get(interaction.guildId)) return;
            try {
              await client.distube.play(channel, url, nextPlayOpts);
            } catch (e) {
              client.logger.warn(`[Playlist Skip] Track ${index + 2} saltado en Guild ${interaction.guildId}:`, e.message);
            }
          })()
        );
        await Promise.allSettled(promises);
        client.playlistLoading.delete(interaction.guildId);
        client.logger.log(`[Playlist Skip] ${urls.length} tracks procesados en Guild: ${interaction.guildId}`);
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
