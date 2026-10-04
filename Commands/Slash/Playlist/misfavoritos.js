const { ApplicationCommandType, PermissionFlagsBits } = require("discord.js");
const UserHistory = require("../../../handlers/UserHistory");
const { respondToInteraction } = require("../../../handlers/functions");

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
    // El defer inicial ya lo hace `events/interactionCreate.js` (ver mislistas.js).
    const embed = await UserHistory.buildFavoritesEmbed(client, interaction.guildId, interaction.user.id, 0);
    if (!embed) {
      return respondToInteraction(interaction, `${client.config.emoji.ERROR} No tienes canciones favoritas aún.`);
    }
    const components = await UserHistory.buildFavoritesComponents(client, interaction.guildId, interaction.user.id, 0);
    const msg = await respondToInteraction(interaction, { embeds: [embed], components });
    if (!msg?.id) return;
    if (!client.favPages) client.favPages = new Map();
    client.favPages.set(msg.id, 0);
  },
};
