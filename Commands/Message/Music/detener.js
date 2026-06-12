const { Message, PermissionFlagsBits } = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "detener",
  aliases: ["st", "destroy", "stop"],
  description: `Detiene la música y limpia la cola`,
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
   * @param {JUGNU} client
   * @param {Message} message
   * @param {String[]} args
   * @param {String} prefix
   * @param {Queue} queue
   */
  run: async (client, message, args, prefix, queue) => {
    // Code
    client.playlistLoading.delete(message.guildId);
    queue.songs = [];
    await queue.stop().catch(() => {});
    try {
      const db = await client.music?.get(`${message.guildId}.vc`);
      if (!db?.enable) await client.distube.voices.leave(message.guild);
    } catch {}
    client.embed(message, `${client.config.emoji.SUCCESS} ¡Cola limpiada y música detenida!`);
  },
};
