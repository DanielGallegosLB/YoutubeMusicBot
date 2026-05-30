const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "quitarcancionlista",
  description: `Quita una canción de tu lista de reproducción`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  type: ApplicationCommandType.ChatInput,
  options: [
    { name: "nombre", description: "Índice de la canción", type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
    { name: "indice", description: "Índice de la canción", type: ApplicationCommandOptionType.Integer, required: true },
  ],
  run: async (client, interaction) => {
    const name = interaction.options.getString("nombre");
    const idx = interaction.options.getInteger("indice");
    const pl = await Store.get(client, interaction.guild.id, interaction.user.id, name);
    if (!pl) return client.embed(interaction, `${client.config.emoji.ERROR} Playlist not found.`);
    const removed = await Store.removeTrack(client, interaction.guild.id, interaction.user.id, pl.name, idx);
    if (!removed) return client.embed(interaction, `${client.config.emoji.ERROR} Invalid index.`);
    return client.embed(interaction, `${client.config.emoji.SUCCESS} Removed \`${removed.name}\` from \`${pl.name}\`.`);
  },
  autocomplete: async (client, interaction) => {
    const focused = interaction.options.getFocused()?.toLowerCase?.() || "";
    const alls = await Store.getAll(client, interaction.guild.id, interaction.user.id);
    const choices = alls.map(p => p.name).filter(Boolean);
    const filtered = choices.filter(c => c.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }
};
