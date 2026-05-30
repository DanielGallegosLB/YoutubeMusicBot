const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "reproducirlista",
  description: `Reproduce una de tus listas de reproducción`,
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
    const pl = await Store.get(client, interaction.guild.id, interaction.user.id, name);
    if (!pl || !pl.tracks.length) return client.embed(interaction, `${client.config.emoji.ERROR} La lista está vacía o no existe.`);
    const vc = interaction.member.voice.channel;
    if (!vc) return client.embed(interaction, `${client.config.emoji.ERROR} Debes unirte a un canal de voz.`);
    if (interaction.guild.members.me.voice.channel && !interaction.guild.members.me.voice.channel.equals(vc))
      return client.embed(interaction, `${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz.`);

    try {
      await interaction.reply({
        content: `⏳ Cargando lista \`${pl.name}\` (${pl.tracks.length} canciones)...`,
        ephemeral: true,
      });

      const playlist = await client.distube.createCustomPlaylist(pl.tracks, {
        member: interaction.member,
        properties: { name: pl.name, url: interaction.url },
        parallel: true
      });

      await client.distube.play(vc, playlist, {
        member: interaction.member,
        textChannel: interaction.channel,
      });

      setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
    } catch (e) {
      client.logger.error("Error al reproducir lista guardada:", e);
      return client.embed(interaction, `${client.config.emoji.ERROR} Error: ${e.message}`);
    }
  },
  autocomplete: async (client, interaction) => {
    const focused = interaction.options.getFocused()?.toLowerCase?.() || "";
    const alls = await Store.getAll(client, interaction.guild.id, interaction.user.id);
    const choices = alls.map(p => p.name).filter(Boolean);
    const filtered = choices.filter(c => c.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }
};
