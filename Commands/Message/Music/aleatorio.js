const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "aleatorio",
  aliases: ["sfl", "shuffle"],
  description: `Mezcla la cola de canciones`,
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
    client.shuffleData.set(`shuffle-${queue.id}`, queue.songs.slice(1));
    queue.shuffle();
    client.embed(
      message,
      `${client.config.emoji.SUCCESS} ¡Se han mezclado ${queue.songs.length} canciones!`
    );
  },
};
