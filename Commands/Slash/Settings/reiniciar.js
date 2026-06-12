const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "reiniciar",
  name_localizations: {
    "en-US": "restart",
    "en-GB": "restart",
  },
  description: `Reinicia la configuración del bot`,
  description_localizations: {
    "en-US": "Restart the bot",
    "en-GB": "Restart the bot",
  },
  userPermissions: PermissionFlagsBits.ManageGuild,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Settings",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: false,
  djOnly: false,

  /**
   *
   * @param {JUGNU} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    // Code
    await client.music.delete(interaction.guildId);
    client.embed(interaction, `${client.config.emoji.SUCCESS} Reseted Done !!`);
  },
};
