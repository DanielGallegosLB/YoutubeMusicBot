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

const YTDLP_PATH = path.join(
  process.cwd(),
  "node_modules/@distube/yt-dlp/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

const CACHE_FILE = path.join(process.cwd(), "playlist-cache.json");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 horas

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {}
  return {};
}

function saveCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8"); } catch {}
}

function isPlaylistURL(url) {
  return /youtube\.com\/playlist\?list=/.test(url) ||
    (/[?&]list=/.test(url) && !/watch\?v=/.test(url));
}

function extractPlaylistId(url) {
  const match = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return match ? match[1] : url;
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
  name: "play",
  description: `play song by song Name/Link`,
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
      name: "song",
      description: `song Name/Link`,
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],

  run: async (client, interaction, args, queue) => {
    let song = interaction.options.getString("song");
    let { channel } = interaction.member.voice;
    const hqStored = await client.music.get(`${interaction.guildId}.hqmode`);
    const hqMode =
      (hqStored === undefined ? process.env.HQ_MODE === "true" : hqStored) || false;
    const playOpts = {
      member: interaction.member,
      textChannel: interaction.channel,
      ...(hqMode ? { volume: 100 } : {}),
    };

    const isURL = /^https?:\/\//i.test(song);

    // --- Playlist ---
    if (isURL && isPlaylistURL(song)) {
      const playlistId = extractPlaylistId(song);
      const cache = loadCache();
      const cached = cache[playlistId];
      let urls;

      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        urls = cached.urls;
        console.log(`[Playlist] Cache hit: ${playlistId} (${urls.length} tracks)`);
        await interaction.followUp({
          content: `📋 **${cached.name || "Playlist"}** — ${urls.length} tracks (desde cache)`,
          ephemeral: true,
        });
      } else {
        await interaction.followUp({
          content: `⏳ Obteniendo playlist por primera vez, un momento...`,
          ephemeral: true,
        });
        try {
          urls = await fetchPlaylistURLs(song);
          cache[playlistId] = { urls, name: "Playlist", fetchedAt: Date.now() };
          saveCache(cache);
          console.log(`[Playlist] Cache guardado: ${playlistId} (${urls.length} tracks)`);
        } catch (e) {
          console.error("[Playlist Error]", e);
          return interaction.followUp({
            content: `❌ No se pudo cargar la playlist: ${e.message}`,
            ephemeral: true,
          });
        }
      }

      try { await client.distube.voices.join(channel); } catch {}

      // Encola primer track y empieza inmediato
      try {
        await client.distube.play(channel, urls[0], playOpts);
      } catch (e) {
        console.error("[Playlist Track 1 Error]", e);
        return interaction.followUp({
          content: `❌ Error en el primer track: ${e.message}`,
          ephemeral: true,
        });
      }

      // Resto en background
      (async () => {
        for (let i = 1; i < urls.length; i++) {
          try {
            await client.distube.play(channel, urls[i], playOpts);
          } catch (e) {
            console.warn(`[Playlist] Track ${i + 1} saltado:`, e.message);
          }
          await new Promise(r => setTimeout(r, 400));
        }
        console.log(`[Playlist] ${urls.length} tracks encolados`);
      })();

      return;
    }

    // --- Canción normal ---
    try { await client.distube.voices.join(channel); } catch {}

    try {
      await client.distube.play(channel, song, playOpts);
    } catch (e) {
      console.error(`[Slash Play Error]`, e);
      return interaction.followUp({
        content: `❌ Error: ${e.message}`,
        ephemeral: true,
      });
    }

    interaction
      .followUp({ content: `Searching \`${song}\``, ephemeral: true })
      .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 3000));
  },
};