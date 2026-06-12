const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "saltara",
  name_localizations: {
    "en-US": "skipto",
    "en-GB": "skipto",
  },
  description: `Salta a una canción específica en la cola`,
  description_localizations: {
    "en-US": "Skip to a specific song in the queue",
    "en-GB": "Skip to a specific song in the queue",
  },
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: true,
  djOnly: true,
  options: [
    {
      name: "indice",
      description: `El índice de la canción a la que quieres saltar`,
      type: ApplicationCommandOptionType.Number,
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
    // Code
    let index = interaction.options.getNumber("indice");
    let song = queue.songs[index];
    if (index > queue.songs.length - 1 || index < 0) {
      return client.embed(
        interaction,
        `${
          client.config.emoji.ERROR
        } **The Position must be between \`0\` and \`${
          queue.songs.length - 1
        }\`!**`
      );
    } else {
      queue.jump(index).then((q) => {
        client.embed(
          interaction,
          `** ${
            client.config.emoji.SUCCESS
          } Jumped to The Song [\`${client.getTitle(song)}\`](${song.url}) **`
        );
      });
    }
  },
};
