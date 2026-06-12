const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "autoresumen",
  name_localizations: {
    "en-US": "autoresume",
    "en-GB": "autoresume",
  },
  description: `Activa o desactiva el resumen automático tras un reinicio`,
  description_localizations: {
    "en-US": "Toggle autoresume on or off",
    "en-GB": "Toggle autoresume on or off",
  },
  userPermissions: PermissionFlagsBits.ManageGuild,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Settings",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  cooldown: 5,
  inVoiceChannel: false,
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
    let data = await client.music.get(`${interaction.guild.id}.autoresume`);
    if (data === true) {
      await client.music.set(`${interaction.guild.id}.autoresume`, false);
      client.embed(
        interaction,
        `** ${client.config.emoji.ERROR} Autoresume System Disabled **`
      );
    } else {
      await client.music.set(`${interaction.guild.id}.autoresume`, true);
      client.embed(
        interaction,
        `** ${client.config.emoji.SUCCESS} Autoresume System Enabled **`
      );
    }
  },
};
