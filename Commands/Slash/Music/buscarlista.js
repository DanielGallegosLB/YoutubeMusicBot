const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
  EmbedBuilder,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "buscarlista",
  name_localizations: {
    "en-US": "searchplaylist",
    "en-GB": "searchplaylist",
  },
  description: `Busca una canción dentro de la lista actual`,
  description_localizations: {
    "en-US": "Search for a playlist",
    "en-GB": "Search for a playlist",
  },
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Music",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: true,
  djOnly: false,
  options: [
    {
      name: "termino",
      description: `El nombre de la canción o autor a buscar`,
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
    const query = interaction.options.getString("termino").toLowerCase();

    const filtered = queue.songs.filter((song) => 
      song.name.toLowerCase().includes(query) || 
      (song.uploader.name && song.uploader.name.toLowerCase().includes(query))
    );

    if (!filtered.length) {
      return client.embed(interaction, `${client.config.emoji.ERROR} No se encontraron canciones que coincidan con "${query}" en la lista.`);
    }

    let tracks = filtered
      .map((song) => {
        const index = queue.songs.indexOf(song);
        return `\`${index === 0 ? "Actual" : index}\`) [\`${client.getTitle(song)}\`](${song.url}) \`[${song.formattedDuration}]\``;
      })
      .join("\n\n");

    let embed = new EmbedBuilder()
      .setColor(client.config.embed.color)
      .setTitle(`Resultados de búsqueda en la lista: \`${query}\``)
      .setDescription(tracks.substring(0, 3800))
      .setFooter(client.getFooter(interaction.user));

    interaction.followUp({ embeds: [embed] });
  },
};
