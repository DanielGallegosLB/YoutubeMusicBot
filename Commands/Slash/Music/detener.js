const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");
const { stopMarqueeActivity } = require("../../../handlers/ActivityManager");

module.exports = {
  name: "detener",
  name_localizations: {
    "en-US": "stop",
    "en-GB": "stop",
  },
  description: `Detiene la música y limpia la cola`,
  description_localizations: {
    "en-US": "Stop the music and clear the queue",
    "en-GB": "Stop the music and clear the queue",
  },
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  Player: false,
  djOnly: true,

  /**
   *
   * @param {MusicBot} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    const guildId = interaction.guildId;
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
    stopMarqueeActivity(client, interaction.guild);
    try {
      await client.distube.voices.leave(interaction.guild);
    } catch {}
    // Resetear el embed del player y la cola para que no queden controles viejos.
    try {
      await client.updateembed(client, interaction.guild).catch(() => {});
      const mus = await client.music.get(`${guildId}.music`).catch(() => null);
      if (mus?.channel) {
        const ch = interaction.guild.channels.cache.get(mus.channel);
        if (ch) await client.editPlayerMessage(ch).catch(() => {});
      }
    } catch {}
    client.logger.log(`[Stop Cmd] Música detenida en Guild ${guildId} por ${interaction.user.id}`);
    client.embed(
      interaction,
      `${client.config.emoji.SUCCESS} La reproducción fue **detenida** por <@${interaction.user.id}> y la cola fue limpiada!`
    );
  },
};
