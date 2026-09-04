const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "detener",
  aliases: ["st", "destroy", "stop"],
  description: `Detiene la música y limpia la cola`,
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
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
    const guildId = message.guildId;
    client.playlistLoading.delete(guildId);
    client.playlistStopped.set(guildId, Date.now());
    await client.autoresume.delete(guildId).catch(() => {});
    queue.songs = [];
    await queue.stop().catch(() => {});
    try {
      const db = await client.music?.get(`${guildId}.vc`);
      if (!db?.enable) await client.distube.voices.leave(message.guild);
    } catch {}
    client.logger.log(`[Stop Msg] Música detenida en Guild ${guildId} por ${message.author.id}`);
    client.embed(message, `${client.config.emoji.SUCCESS} La reproducción fue **detenida** por <@${message.author.id}> y la cola fue limpiada!`);
  },
};
