const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");

module.exports = {
  name: "calidadalta",
  name_localizations: {
    "en-US": "highquality",
    "en-GB": "highquality",
  },
  description: "Activa o desactiva el modo de alta calidad",
  description_localizations: {
    "en-US": "Toggle high quality on or off",
    "en-GB": "Toggle high quality on or off",
  },
  userPermissions: PermissionFlagsBits.ManageGuild,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Settings",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,

  /**
   * @param {JUGNU} client
   * @param {CommandInteraction} interaction
   */
  run: async (client, interaction) => {
    const key = `${interaction.guildId}.hqmode`;
    const current = (await client.music.get(key)) ?? false;
    const next = !current;
    await client.music.set(key, next);
    return client.embed(
      interaction,
      `${client.config.emoji.SUCCESS} High-Quality mode is now ${next ? "Enabled" : "Disabled"}.`
    );
  },
};
