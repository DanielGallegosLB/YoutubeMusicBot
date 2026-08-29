const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "limpiarlista",
  name_localizations: {
    "en-US": "clearqueue",
    "en-GB": "clearqueue",
  },
  description: `Limpia la cola de reproducción`,
  description_localizations: {
    "en-US": "Clear the playback queue",
    "en-GB": "Clear the playback queue",
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
    queue.songs = [queue.songs[0]];
    client.embed(
      interaction,
      `${client.config.emoji.SUCCESS} ¡Cola de reproducción vaciada!`
    );
  },
};
