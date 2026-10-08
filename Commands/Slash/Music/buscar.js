const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { searchYoutubeVideos } = require("../../../handlers/PlaylistFetcher");
const PlaylistStore = require("../../../handlers/PlaylistStore");
const { numberEmojis } = require("../../../settings/config");

const fmtDuration = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
};

const matches = (q, ...fields) => {
  const needle = q.toLowerCase();
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(needle));
};

module.exports = {
  name: "buscar",
  name_localizations: {
    "en-US": "search",
    "en-GB": "search",
  },
  description: `Busca en YouTube, en la cola actual o en tus listas guardadas`,
  description_localizations: {
    "en-US": "Search YouTube, the current queue or your saved playlists",
    "en-GB": "Search YouTube, the current queue or your saved playlists",
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
      name: "song",
      description: `Qué quieres buscar (nombre o URL)`,
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: "origen",
      description: `Dónde buscar (por defecto YouTube)`,
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "YouTube", value: "youtube" },
        { name: "Cola actual", value: "cola" },
        { name: "Mis listas guardadas", value: "guardadas" },
      ],
    },
  ],

  /**
   *
   * @param {MusicBot} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    const query = (interaction.options.getString("song") || "").trim();
    const origen = interaction.options.getString("origen") || "youtube";
    if (!query) return;

    const limit = origen === "youtube" ? 10 : 25;
    let results = [];
    let mode = "play"; // "play" (YouTube/listas) o "jump" (cola)

    if (origen === "youtube") {
      results = await searchYoutubeVideos(query, limit);
    } else if (origen === "cola") {
      mode = "jump";
      const q = client.distube.getQueue(interaction.guildId);
      if (!q || !q.songs?.length) {
        return interaction.followUp({
          content: `${client.config.emoji.ERROR} No hay canciones en la cola para buscar.`,
          ephemeral: true,
        });
      }
      results = q.songs
        .map((song, index) => ({
          index,
          url: song.url,
          name: song.name,
          duration: Number(song.duration) || 0,
          uploader: song.uploader?.name || "",
        }))
        .filter((s) => matches(query, s.name, s.uploader))
        .slice(0, 25);
    } else if (origen === "guardadas") {
      const all = await PlaylistStore.getAll(client, interaction.guildId, interaction.user.id);
      const seen = new Set();
      const flat = [];
      for (const tracks of Object.values(all || {})) {
        for (const t of tracks || []) {
          if (!t?.url) continue;
          const key = PlaylistStore.canonUrlKey(t.url);
          if (seen.has(key)) continue;
          seen.add(key);
          flat.push({
            url: t.url,
            name: t.name || "Sin título",
            duration: Number(t.duration) || 0,
            uploader: t.uploader || "",
          });
        }
      }
      results = flat.filter((s) => matches(query, s.name, s.uploader)).slice(0, 25);
    }

    if (!results.length) {
      return interaction.followUp({
        content: `${client.config.emoji.ERROR} Sin resultados para \`${query}\` (${origen}).`,
        ephemeral: true,
      });
    }

    const listText = results
      .map(
        (s, i) =>
          `\`${i + 1}\`) [\`${client.getTitle(s)}\`](${s.url}) \`[${
            s.formattedDuration || fmtDuration(s.duration)
          }]\``
      )
      .join("\n\n");

    const embed = new EmbedBuilder()
      .setColor(client.config.embed.color)
      .setTitle(`Resultados de \`${query}\``)
      .setDescription(listText.substring(0, 3800))
      .setFooter(client.getFooter(interaction.user));

    const menu = new ActionRowBuilder().addComponents([
      new StringSelectMenuBuilder()
        .setCustomId("buscar_select")
        .setPlaceholder("Elige una canción para reproducir")
        .addOptions(
          results.map((s, i) => ({
            label: client.getTitle(s),
            value: String(i),
            description: `${s.uploader || "YouTube"}`.slice(0, 100),
            emoji: numberEmojis[i + 1],
          }))
        ),
    ]);

    const { channel } = interaction.member.voice;
    interaction
      .followUp({ embeds: [embed], components: [menu] })
      .then((msg) => {
        const collector = msg.createMessageComponentCollector({
          filter: (i) => i.user.id === interaction.user.id,
          time: 120000,
        });
        collector.on("collect", async (i) => {
          if (!i.isStringSelectMenu() || i.customId !== "buscar_select") return;
          await i.deferUpdate().catch(() => {});
          const picked = results[Number(i.values[0])];
          if (!picked) return;
          try {
            if (mode === "jump") {
              const q = client.distube.getQueue(interaction.guildId);
              if (!q) return;
              if (picked.index > 0) await q.jump(picked.index);
            } else {
              await client.distube.play(channel, picked.url, {
                member: i.member,
                textChannel: i.channel,
              });
            }
          } catch (_e) {}
        });
        collector.on("end", () => {
          msg.edit({ components: [] }).catch(() => {});
        });
      });
  },
};