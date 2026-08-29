const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "continuar",
  name_localizations: {
    "en-US": "resume",
    "en-GB": "resume",
  },
  description: `Continúa la música pausada`,
  description_localizations: {
    "en-US": "Resume paused music",
    "en-GB": "Resume paused music",
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
    if (queue.paused) {
      queue.resume();
      client.embed(
        interaction,
        `${client.config.emoji.SUCCESS} Queue Resumed !!`
      );
    } else {
      client.embed(
        interaction,
        `${client.config.emoji.ERROR} Queue already Resumed !!`
      );
    }
  },
};
