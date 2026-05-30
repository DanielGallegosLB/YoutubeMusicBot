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
  name: "reproducir",
  description: `Reproduce una canción o lista de reproducción`,
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
      description: `El nombre o enlace de la canción/lista`,
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

      // Toca primer track inmediatamente
      try {
        await client.distube.play(channel, urls[0], playOpts);
        client.logger.log(`[Slash Play Success] First track: ${urls[0]}`);
      } catch (e) {
        client.logger.error("[Slash Play First Track Error]", e);
        try {
          await interaction.followUp({
            content: `❌ Error en el primer track: ${e.message}`,
            ephemeral: true,
          });
        } catch (err) {}
        return;
      }

      // Resto en background con concurrencia limitada (lotes)
      const nextPlayOpts = { ...playOpts, skip: false };
      client.playlistLoading.set(interaction.guildId, true);
      (async () => {
        const batchSize = 5;
        const remaining = urls.slice(1);
        try {
          for (let i = 0; i < remaining.length; i += batchSize) {
            if (!client.playlistLoading.get(interaction.guildId)) break;
            const batch = remaining.slice(i, i + batchSize);
            const promises = batch.map((url, index) =>
              (async () => {
                try {
                  await client.distube.play(channel, url, nextPlayOpts);
                } catch (e) {
                  client.logger.warn(`[Slash Play] Track ${i + index + 2} saltado en Guild ${interaction.guildId}:`, e.message);
                }
              })()
            );
            await Promise.allSettled(promises);
            // small pause between batches to let DisTube settle
            await new Promise((r) => setTimeout(r, 100));
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