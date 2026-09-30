const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");
const { stopMarqueeActivity } = require("../../../handlers/ActivityManager");

module.exports = {
  name: "detener",
  aliases: ["st", "destroy", "stop"],
  description: `Detiene la música y limpia la cola`,
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  Player: false,
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
    client.autoDjDisable?.(guildId);
    client.playlistLoading.delete(guildId);
    client.playlistStopped.set(guildId, Date.now());
    // Detener el timer de autoresume de este guild para que NO re-guarde la
    // cola tras el stop (si seguía corriendo, en el próximo reinicio volvía a
    // reproducir lo que el usuario ya había detenido).
    if (client._autoresumeTimers?.has(guildId)) {
      clearInterval(client._autoresumeTimers.get(guildId));
      client._autoresumeTimers.delete(guildId);
    }
    await client.autoresume.delete(guildId).catch(() => {});
    if (client.actualPlaying) client.actualPlaying.delete(guildId);
    if (queue) {
      queue.songs = [];
      await queue.stop().catch(() => {});
    }
    stopMarqueeActivity(client, message.guild);
    try {
      await client.distube.voices.leave(message.guild);
    } catch {}
    // Resetear el embed del player y la cola para que no queden controles viejos.
    try {
      await client.updateembed(client, message.guild).catch(() => {});
      const mus = await client.music.get(`${guildId}.music`).catch(() => null);
      if (mus?.channel) {
        const ch = message.guild.channels.cache.get(mus.channel);
        if (ch) await client.editPlayerMessage(ch).catch(() => {});
      }
    } catch {}
    client.logger.log(`[Stop Msg] Música detenida en Guild ${guildId} por ${message.author.id}`);
    client.embed(message, `${client.config.emoji.SUCCESS} La reproducción fue **detenida** por <@${message.author.id}> y la cola fue limpiada!`);
  },
};
