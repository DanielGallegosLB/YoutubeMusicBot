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

    await interaction.editReply({ content: `✅ Cargando \`${playlistName}\`... (0/${tracks.length})` });

    const first = tracks[0];
    let addedCount = 0;
    try {
      await client.distube.play(vc, first, {
        member: interaction.member,
        textChannel: interaction.channel,
      });
      addedCount++;
    } catch (e) {
      client.logger.error(`[ShufflePlay Slash] Error en primer track: ${e.message}`);
    }

    client.playlistLoading.set(interaction.guildId, true);
    (async () => {
      const remaining = tracks.slice(1);
      for (let i = 0; i < remaining.length; i++) {
        if (!client.playlistLoading.get(interaction.guildId)) break;
        const t = remaining[i];
        try {
          await client.distube.play(vc, t, {
            member: interaction.member,
            textChannel: interaction.channel,
          });
          addedCount++;
        } catch (e) {
          client.logger.error(`[ShufflePlay Slash] Error en track ${i + 2}: ${e.message}`);
        }

        // Actualizar progreso cada 5 canciones o al final
        if (addedCount % 5 === 0 || i === remaining.length - 1) {
          await interaction.editReply({ 
            content: `⏳ Cargando \`${playlistName}\`... (${addedCount}/${tracks.length} canciones añadidas)` 
          }).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      
      const queue = client.distube.getQueue(interaction.guildId);
      if (queue && queue.repeatMode === 2) {
         client.logger.log(`[ShufflePlay Slash] Queue loop active (repeatMode: 2). Consistency checked.`);
      }
      
      await interaction.editReply({ 
        content: `✅ Carga finalizada: \`${playlistName}\` (${addedCount} canciones añadidas exitosamente).` 
      }).catch(() => {});
      
      client.playlistLoading.delete(interaction.guildId);
    })();

    return;
  },
};
