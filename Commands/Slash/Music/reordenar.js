const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "reordenar",
  name_localizations: {
    "en-US": "reorder",
    "en-GB": "reorder",
  },
  description: `Mueve una canción de la lista a una nueva posición`,
  description_localizations: {
    "en-US": "Reorder the playback queue",
    "en-GB": "Reorder the playback queue",
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
      name: "de",
      description: `Posición actual de la canción`,
      type: ApplicationCommandOptionType.Integer,
      required: true,
    },
    {
      name: "a",
      description: `Nueva posición para la canción`,
      type: ApplicationCommandOptionType.Integer,
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
    const from = interaction.options.getInteger("de");
    const to = interaction.options.getInteger("a");

    if (from < 1 || to < 1 || from >= queue.songs.length || to >= queue.songs.length) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR} Las posiciones deben estar entre 1 y ${queue.songs.length - 1}.`
      );
    }

    if (from === to) return client.embed(interaction, `${client.config.emoji.ERROR} La canción ya está en esa posición.`);

    const song = queue.songs[from];
    queue.songs.splice(from, 1);
    queue.songs.splice(to, 0, song);

    client.embed(
      interaction,
      `${client.config.emoji.SUCCESS} Se ha movido **${client.getTitle(song)}** de la posición \`${from}\` a la \`${to}\`.`
    );
  },
};
