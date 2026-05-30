const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");
const JUGNU = require("../../../handlers/Client");

module.exports = {
  name: "crearlista",
  description: `Crea una nueva lista de reproducción personalizada`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  type: ApplicationCommandType.ChatInput,
  options: [
    { name: "nombre", description: "Nombre de la lista", type: ApplicationCommandOptionType.String, required: true },
  ],
  run: async (client, interaction) => {
    const name = interaction.options.getString("nombre");
    await Store.create(client, interaction.guild.id, interaction.user.id, name);
    return client.embed(interaction, `${client.config.emoji.SUCCESS} Created playlist \`${name}\`.`);
  },
};
