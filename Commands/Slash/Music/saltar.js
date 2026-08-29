const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");
const { skip } = require("../../../handlers/functions");

module.exports = {
  name: "saltar",
  name_localizations: {
    "en-US": "skip",
    "en-GB": "skip",
  },
  description: `Salta la canción actual`,
  description_localizations: {
    "en-US": "Skip to the next song",
    "en-GB": "Skip to the next song",
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
    await skip(queue);
    client.embed(
      interaction,
      `${client.config.emoji.SUCCESS}  Song Skipped !!`
    );
  },
};
