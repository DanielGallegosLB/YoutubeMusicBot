const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "borrarlista",
  description: `Borra una lista de reproducción personalizada`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  type: ApplicationCommandType.ChatInput,
  options: [
    { name: "nombre", description: "Nombre de la lista", type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
  ],
  run: async (client, interaction) => {
    const name = interaction.options.getString("nombre");
    const ok = await Store.delete(client, interaction.guild.id, interaction.user.id, name);
    if (!ok) return client.embed(interaction, `${client.config.emoji.ERROR} Playlist not found.`);
    return client.embed(interaction, `${client.config.emoji.SUCCESS} Deleted playlist \`${name}\`.`);
  },
  autocomplete: async (client, interaction) => {
    const focused = interaction.options.getFocused()?.toLowerCase?.() || "";
    const alls = await Store.getAll(client, interaction.guild.id, interaction.user.id);
    const choices = alls.map(p => p.name).filter(Boolean);
    const filtered = choices.filter(c => c.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }
};
