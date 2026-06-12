const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const Store = require("../../../handlers/PlaylistStore");
const { spawn } = require("child_process");
const path = require("path");

const YTDLP_PATH = path.join(
  process.cwd(),
  "node_modules/@distube/yt-dlp/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

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

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

module.exports = {
  name: "reproduciraleatorio",
  name_localizations: {
    "en-US": "shuffleplay",
    "en-GB": "shuffleplay",
  },
  description: `Reproduce una lista de reproducción en modo aleatorio`,
  description_localizations: {
    "en-US": "Play a playlist in shuffle mode",
    "en-GB": "Play a playlist in shuffle mode",
  },
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: false,
  djOnly: false,
  options: [
    {
      name: "lista",
      name_localizations: {
        "en-US": "playlist",
        "en-GB": "playlist",
      },
      description: `El nombre de la lista o URL`,
      description_localizations: {
        "en-US": "The name of the playlist or URL",
        "en-GB": "The name of the playlist or URL",
      },
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],

  run: async (client, interaction, args, queue) => {
    const query = interaction.options.getString("lista");
    const vc = interaction.member.voice.channel;

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: `⏳ Procesando...`, ephemeral: true }).catch(() => {});
      } else {
        await interaction.editReply({ content: `⏳ Procesando...` }).catch(() => {});
      }
    } catch (e) {}

    let tracks = [];
    let playlistName = "";
    const isURL = /^https?:\/\//i.test(query);

    if (isURL) {
      playlistName = "URL Playlist";
      try {
        tracks = await fetchPlaylistURLs(query);
      } catch (e) {
        return interaction.editReply({ content: `❌ Error al obtener la lista: ${e.message}` });
      }
    } else {
      const pl = await Store.get(client, interaction.guild.id, interaction.user.id, query);
      if (!pl || !pl.tracks.length) return interaction.editReply({ content: `❌ Lista no encontrada o vacía.` });
      tracks = pl.tracks.map(t => t.url || t.name);
      playlistName = pl.name;
    }

    shuffleArray(tracks);

    const first = tracks[0];
    await client.distube.play(vc, first, {
      member: interaction.member,
      textChannel: interaction.channel,
    });

    client.playlistLoading.set(interaction.guildId, true);
    (async () => {
      for (const t of tracks.slice(1)) {
        if (!client.playlistLoading.get(interaction.guildId)) break;
        try {
          await client.distube.play(vc, t, {
            member: interaction.member,
            textChannel: interaction.channel,
          });
        } catch (e) {
          client.logger.error(`[ShufflePlay Slash] Error: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const queue = client.distube.getQueue(interaction.guildId);
      if (queue && queue.repeatMode === 2) {
         client.logger.log(`[ShufflePlay Slash] Queue loop active (repeatMode: 2). Consistency checked.`);
      }
      client.playlistLoading.delete(interaction.guildId);
    })();

    return interaction.editReply({ content: `✅ Reproduciendo aleatoriamente \`${playlistName}\` (${tracks.length} canciones).` });
  },
};
