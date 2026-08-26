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
    await interaction.deferReply().catch(() => {});
    const embed = await UserHistory.buildFavoritesEmbed(client, interaction.guildId, interaction.user.id, 0);
    if (!embed) return interaction.editReply(`${client.config.emoji.ERROR} No tienes canciones favoritas aún.`);
    const components = await UserHistory.buildFavoritesComponents(client, interaction.guildId, interaction.user.id, 0);
    const msg = await interaction.editReply({ embeds: [embed], components });
    if (!client.favPages) client.favPages = new Map();
    client.favPages.set(msg.id, 0);
  },
};
