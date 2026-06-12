const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "detener",
  description: `Detiene la música y limpia la cola`,
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
   * @param {JUGNU} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    // Code
    client.playlistLoading.delete(interaction.guildId);
    queue.songs = [];
    await queue.stop().catch(() => {});
    try {
      const db = await client.music?.get(`${interaction.guildId}.vc`);
      if (!db?.enable) await client.distube.voices.leave(interaction.guild);
    } catch {}
    client.embed(
      interaction,
      `${client.config.emoji.SUCCESS} ¡Cola limpiada y música detenida!`
    );
  },
};
