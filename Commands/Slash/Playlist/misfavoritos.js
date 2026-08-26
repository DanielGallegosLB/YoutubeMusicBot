const { ApplicationCommandType, PermissionFlagsBits } = require("discord.js");
const UserHistory = require("../../../handlers/UserHistory");

module.exports = {
  name: "misfavoritos",
  name_localizations: {
    "en-US": "myfavorites",
    "en-GB": "myfavorites",
  },
  description: `Gestiona tus canciones favoritas`,
  description_localizations: {
    "en-US": "Manage your favorite songs",
    "en-GB": "Manage your favorite songs",
  },
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  type: ApplicationCommandType.ChatInput,
  run: async (client, interaction) => {
    const embed = await UserHistory.buildFavoritesEmbed(client, interaction.guildId, interaction.user.id, 0);
    if (!embed) return client.embed(interaction, `${client.config.emoji.ERROR} No tienes canciones favoritas aún.`);
    const components = await UserHistory.buildFavoritesComponents(client, interaction.guildId, interaction.user.id, 0);
    return interaction.followUp({ embeds: [embed], components });
  },
};
