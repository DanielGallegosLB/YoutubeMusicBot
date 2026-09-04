const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

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
    const guildId = interaction.guildId;
    client.playlistLoading.delete(guildId);
    client.playlistStopped.set(guildId, Date.now());
    await client.autoresume.delete(guildId).catch(() => {});
    queue.songs = [];
    await queue.stop().catch(() => {});
    try {
      const db = await client.music?.get(`${guildId}.vc`);
      if (!db?.enable) await client.distube.voices.leave(interaction.guild);
    } catch {}
    client.logger.log(`[Stop Cmd] Música detenida en Guild ${guildId} por ${interaction.user.id}`);
    client.embed(
      interaction,
      `${client.config.emoji.SUCCESS} La reproducción fue **detenida** por <@${interaction.user.id}> y la cola fue limpiada!`
    );
  },
};
