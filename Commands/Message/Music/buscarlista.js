const { Message, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "buscarlista",
  aliases: ["qsearch", "findq", "searchplaylist"],
  description: `Busca una canción dentro de la cola actual`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Music",
  cooldown: 5,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: true,
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
    const query = args.join(" ").toLowerCase();
    if (!query) {
      return client.embed(message, `${client.config.emoji.ERROR} Por favor, proporciona un término de búsqueda.`);
    }

    const filtered = queue.songs.filter((song, index) => 
      song.name.toLowerCase().includes(query) || 
      (song.uploader.name && song.uploader.name.toLowerCase().includes(query))
    );

    if (!filtered.length) {
      return client.embed(message, `${client.config.emoji.ERROR} No se encontraron canciones que coincidan con "${query}" en la lista.`);
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
      .setFooter(client.getFooter(message.author));

    message.reply({ embeds: [embed] });
  },
};
