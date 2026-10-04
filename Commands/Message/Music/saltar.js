const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");
const { skip, recordSkipSignal } = require("../../../handlers/functions");

module.exports = {
  name: "saltar",
  aliases: ["s", "skp", "skip"],
  description: `Salta la canción actual`,
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
    recordSkipSignal(client, message.guildId, message.author?.id, queue);
    await skip(queue);
    client.embed(message, `${client.config.emoji.SUCCESS}  Song Skipped !!`);
  },
};
