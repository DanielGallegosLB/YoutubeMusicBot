const {
  Message,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");
const { searchYoutubeVideos } = require("../../../handlers/PlaylistFetcher");
const { numberEmojis } = require("../../../settings/config");

module.exports = {
  name: "buscar",
  aliases: ["sr", "find", "search"],
  description: `Busca canciones en YouTube`,
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: false,
  djOnly: false,

  /**
   *
   * @param {MusicBot} client
   * @param {Message} message
   * @param {String[]} args
   * @param {String} prefix
   * @param {Queue} queue
   */
  run: async (client, message, args, prefix, queue) => {
    const query = args.join(" ").trim();
    if (!query) {
      return client.embed(message, `Please Provide Song Name to Search`);
    }

    const results = await searchYoutubeVideos(query, 10);
    if (!results.length) {
      return client.embed(message, `No se encontraron resultados para \`${query}\``);
    }

    const tracks = results
      .map(
        (song, index) =>
          `\`${index + 1}\`) [\`${client.getTitle(song)}\`](${song.url}) ` +
          `\`[${song.duration ? new Date(song.duration * 1000).toISOString().substr(14, 5) : "0:00"}]\``
      )
      .join("\n\n");

    const embed = new EmbedBuilder()
      .setColor(client.config.embed.color)
      .setTitle(`\`${query}\` Search Results`)
      .setDescription(tracks.substring(0, 3800))
      .setFooter(client.getFooter(message.author));

    const menuraw = new ActionRowBuilder().addComponents([
      new StringSelectMenuBuilder()
        .setCustomId("buscar_select")
        .setPlaceholder(`Click to See Best Songs`)
        .addOptions(
          results.map((song, index) => ({
            label: client.getTitle(song),
            value: String(index),
            description: `${song.uploader || "YouTube"}`.slice(0, 100),
            emoji: numberEmojis[index + 1],
          }))
        ),
    ]);

    const { channel } = message.member.voice;
    message
      .reply({ embeds: [embed], components: [menuraw] })
      .then((msg) => {
        const collector = msg.createMessageComponentCollector({
          filter: (i) => i.user.id === message.author.id,
          time: 120000,
        });
        collector.on("collect", async (interaction) => {
          if (!interaction.isStringSelectMenu() || interaction.customId !== "buscar_select") return;
          await interaction.deferUpdate().catch(() => {});
          const picked = results[Number(interaction.values[0])];
          if (!picked) return;
          await client.distube.play(channel, picked.url, {
            member: message.member,
            textChannel: message.channel,
          });
        });
      });
  },
};
