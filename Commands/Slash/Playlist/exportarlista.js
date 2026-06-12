const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits, AttachmentBuilder } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "exportarlista",
  name_localizations: {
    "en-US": "exportplaylist",
    "en-GB": "exportplaylist",
  },
  description: `Exporta tu lista de reproducción`,
  description_localizations: {
    "en-US": "Export a playlist",
    "en-GB": "Export a playlist",
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
    "en-US": "Export a playlist",
    "en-GB": "Export a playlist",
  }, type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
  ],
  run: async (client, interaction) => {
    const name = interaction.options.getString("nombre");
    const pl = await Store.get(client, interaction.guild.id, interaction.user.id, name);
    if (!pl) return client.embed(interaction, `${client.config.emoji.ERROR} Playlist not found.`);
    const json = Buffer.from(JSON.stringify({ name: pl.name, tracks: pl.tracks }, null, 2));
    const file = new AttachmentBuilder(json, { name: `${pl.name}.playlist.json` });
    return interaction.followUp({ files: [file] }).catch(() => {});
  },
  autocomplete: async (client, interaction) => {
    const focused = interaction.options.getFocused()?.toLowerCase?.() || "";
    const alls = await Store.getAll(client, interaction.guild.id, interaction.user.id);
    const choices = alls.map(p => p.name).filter(Boolean);
    const filtered = choices.filter(c => c.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }
};
