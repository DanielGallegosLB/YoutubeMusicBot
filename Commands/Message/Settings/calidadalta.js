const { Message, PermissionFlagsBits } = require("discord.js");
const JUGNU = require("../../../handlers/Client");

module.exports = {
  name: "calidadalta",
  aliases: ["highquality", "hq"],
  description: "Activa o desactiva el modo de alta calidad",
  userPermissions: PermissionFlagsBits.ManageGuild,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Settings",
  cooldown: 5,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,

  /**
   * @param {JUGNU} client
   * @param {Message} message
   */
  run: async (client, message) => {
    const key = `${message.guildId}.hqmode`;
    const current = (await client.music.get(key)) ?? false;
    const next = !current;
    await client.music.set(key, next);
    return client.embed(
      message,
      `${client.config.emoji.SUCCESS} High-Quality mode is now ${next ? "Enabled" : "Disabled"}.`
    );
  },
};
