const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");
const MusicBot = require("../../../handlers/Client");

module.exports = {
  name: "crearlista",
  name_localizations: {
    "en-US": "createplaylist",
    "en-GB": "createplaylist",
  },
  description: `Crea una nueva lista de reproducción personalizada`,
  description_localizations: {
    "en-US": "Create a new playlist",
    "en-GB": "Create a new playlist",
  },
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      name: "nombre",
      name_localizations: {
        "en-US": "name",
        "en-GB": "name",
      },
      description: "Nombre de la lista",
      description_localizations: {
        "en-US": "The name of the playlist",
        "en-GB": "The name of the playlist",
      },
  description_localizations: {
    "en-US": "Create a new playlist",
    "en-GB": "Create a new playlist",
  }, type: ApplicationCommandOptionType.String, required: true },
  ],
  run: async (client, interaction) => {
    const name = interaction.options.getString("nombre");
    await Store.create(client, interaction.guild.id, interaction.user.id, name);
    return client.embed(interaction, `${client.config.emoji.SUCCESS} Created playlist \`${name}\`.`);
  },
};
