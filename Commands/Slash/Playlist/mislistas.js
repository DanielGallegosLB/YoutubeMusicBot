const { ApplicationCommandType, PermissionFlagsBits } = require("discord.js");
const UserHistory = require("../../../handlers/UserHistory");
const { respondToInteraction } = require("../../../handlers/functions");

module.exports = {
  name: "mislistas",
  name_localizations: {
    "en-US": "mylists",
    "en-GB": "mylists",
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
    // NO se difiere acá: `events/interactionCreate.js` ya lo hizo para todos los
    // comandos de slash. Un segundo deferReply era redundante y, si el primero
    // había fallado, el editReply de abajo moría con InteractionNotReplied.
    const embed = await UserHistory.buildPreviewEmbed(client, interaction.guildId, interaction.user.id);
    if (!embed) {
      return respondToInteraction(interaction, `${client.config.emoji.ERROR} No tienes listas guardadas aún.`);
    }
    const components = await UserHistory.buildPreviewComponents(client, interaction.guildId, interaction.user.id);
    return respondToInteraction(interaction, { embeds: [embed], components });
  },
};
