const { ApplicationCommandType, PermissionFlagsBits } = require("discord.js");
const UserHistory = require("../../../handlers/UserHistory");

module.exports = {
  name: "listasguardadas",
  name_localizations: {
    "en-US": "savedlists",
    "en-GB": "savedlists",
  },
  description: `Muestra tus listas guardadas y favoritos`,
  description_localizations: {
    "en-US": "Show your saved playlists and favorites",
    "en-GB": "Show your saved playlists and favorites",
  },
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  type: ApplicationCommandType.ChatInput,
  run: async (client, interaction) => {
    const embed = await UserHistory.buildPreviewEmbed(client, interaction.guildId, interaction.user.id);
    if (!embed) return client.embed(interaction, `${client.config.emoji.ERROR} No tienes listas guardadas aún.`);
    const components = await UserHistory.buildPreviewComponents(client, interaction.guildId, interaction.user.id);
    return interaction.followUp({ embeds: [embed], components });
  },
};
