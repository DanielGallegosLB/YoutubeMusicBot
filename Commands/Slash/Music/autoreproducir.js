const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "autoreproducir",
  name_localizations: {
    "en-US": "autoplay",
    "en-GB": "autoplay",
  },
  description: `Activa o desactiva la autorreproducción`,
  description_localizations: {
    "en-US": "Toggle autoplay on or off",
    "en-GB": "Toggle autoplay on or off",
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

  /**
   *
   * @param {MusicBot} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    // Code
    let autoplay = queue.toggleAutoplay();

    client.embed(
      interaction,
      `${client.config.emoji.SUCCESS} AutoPlay: \`${autoplay ? "On" : "Off"}\``
    );
  },
};
