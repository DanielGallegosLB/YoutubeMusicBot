const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "detalleslista",
  name_localizations: {
    "en-US": "playlistdetails",
    "en-GB": "playlistdetails",
  },
  description: `Muestra los detalles de una lista de reproducción`,
  description_localizations: {
    "en-US": "View playlist details",
    "en-GB": "View playlist details",
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
    "en-US": "View playlist details",
    "en-GB": "View playlist details",
  }, type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
  ],
  run: async (client, interaction) => {
    const name = interaction.options.getString("nombre");
    const pl = await Store.get(client, interaction.guild.id, interaction.user.id, name);
    if (!pl) return client.embed(interaction, `${client.config.emoji.ERROR} Playlist not found.`);
    const lines = pl.tracks.slice(0, 25).map((t, i) => `\`${i + 1}.\` **${t.name}** ${t.formattedDuration ? `- \`${t.formattedDuration}\`` : ""}`);
    const more = pl.tracks.length > 25 ? `\n…and ${pl.tracks.length - 25} more` : "";
    const embed = new EmbedBuilder()
      .setColor(client.config.embed.color)
      .setTitle(`Playlist: ${pl.name}`)
      .setDescription(lines.join("\n") + more)
      .setFooter(client.getFooter(interaction.user));
    return interaction.followUp({ embeds: [embed] });
  },
  autocomplete: async (client, interaction) => {
    const focused = interaction.options.getFocused()?.toLowerCase?.() || "";
    const alls = await Store.getAll(client, interaction.guild.id, interaction.user.id);
    const choices = alls.map(p => p.name).filter(Boolean);
    const filtered = choices.filter(c => c.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }
};
