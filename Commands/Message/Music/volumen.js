const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "volumen",
  aliases: ["vol", "volume"],
  description: `Cambia el volumen del bot`,
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: true,
  djOnly: true,

  /**
   *
   * @param {MusicBot} client
   * @param {Message} message
   * @param {String[]} args
   * @param {String} prefix
   * @param {Queue} queue
   */
  run: async (client, message, args, prefix, queue) => {
    // Code
    let volume = Number(args[0]);
    if (!volume) {
      return client.embed(
        message,
        `${client.config.emoji.ERROR} Please Provide Volume %`
      );
    } else if (volume > 250) {
      return client.embed(
        message,
        `${client.config.emoji.ERROR} Provide Volume Amount Between 1 - 250  !!`
      );
    } else {
      await queue.setVolume(volume);
      client.embed(
        message,
        `${client.config.emoji.SUCCESS} Volume Set to ${queue.volume}% !!`
      );
    }
  },
};
