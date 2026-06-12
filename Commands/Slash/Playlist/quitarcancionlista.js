const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "quitarcancionlista",
  name_localizations: {
    "en-US": "removefromplaylist",
    "en-GB": "removefromplaylist",
  },
  description: `Quita una canción de tu lista de reproducción`,
  description_localizations: {
    "en-US": "Remove a song from a playlist",
    "en-GB": "Remove a song from a playlist",
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
      description: "Índice de la canción",
      description_localizations: {
        "en-US": "The name of the playlist",
        "en-GB": "The name of the playlist",
      },
  description_localizations: {
    "en-US": "Remove a song from a playlist",
    "en-GB": "Remove a song from a playlist",
  }, type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
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
