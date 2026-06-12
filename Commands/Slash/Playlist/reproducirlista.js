const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "reproducirlista",
  name_localizations: {
    "en-US": "playplaylist",
    "en-GB": "playplaylist",
  },
  description: `Reproduce una de tus listas de reproducción`,
  description_localizations: {
    "en-US": "Play a saved playlist",
    "en-GB": "Play a saved playlist",
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
      type: ApplicationCommandOptionType.String,
      required: true,
      autocomplete: true,
    },
  ],
  run: async (client, interaction) => {
    const name = interaction.options.getString("nombre");
    const pl = await Store.get(client, interaction.guild.id, interaction.user.id, name);
    if (!pl || !pl.tracks.length)
      return client.embed(interaction, `${client.config.emoji.ERROR} La lista está vacía o no existe.`);
    const vc = interaction.member.voice.channel;
    if (!vc)
      return client.embed(interaction, `${client.config.emoji.ERROR} Debes unirte a un canal de voz.`);
    if (interaction.guild.members.me.voice.channel && !interaction.guild.members.me.voice.channel.equals(vc))
      return client.embed(interaction, `${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz.`);

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({
          content: `⏳ Cargando lista \`${pl.name}\` (${pl.tracks.length} canciones)...`,
          ephemeral: true,
        });
      } else {
        await interaction.editReply({
          content: `⏳ Cargando lista \`${pl.name}\` (${pl.tracks.length} canciones)...`,
        });
      }

      const first = pl.tracks[0];
      let addedCount = 0;
      try {
        await client.distube.play(vc, first.url || first.name, {
          member: interaction.member,
          textChannel: interaction.channel,
        });
        addedCount++;
      } catch (e) {
        client.logger.error("Error al cargar primer track:", e);
      }

      client.playlistLoading.set(interaction.guild.id, true);
      (async () => {
        const tracks = pl.tracks.slice(1);
        for (let i = 0; i < tracks.length; i++) {
          if (!client.playlistLoading.get(interaction.guild.id)) break;
          const t = tracks[i];
          try {
            await client.distube.play(vc, t.url || t.name, {
              member: interaction.member,
              textChannel: interaction.channel,
            });
            addedCount++;
          } catch (e) {
            client.logger.error("Error al cargar pista de lista:", e);
          }

          // Actualizar progreso cada 5 canciones o al final
          if (addedCount % 5 === 0 || i === tracks.length - 1) {
            await interaction.editReply({
              content: `⏳ Cargando lista \`${pl.name}\`... (${addedCount}/${pl.tracks.length} canciones añadidas)`,
            }).catch(() => {});
          }

          await new Promise((r) => setTimeout(r, 250));
        }

        const queue = client.distube.getQueue(interaction.guild.id);
        if (queue && queue.repeatMode === 2) {
          client.logger.log(
            `[Playlist Play] Queue loop is active (repeatMode: 2) in Guild ${interaction.guildId}. New items included.`
          );
        }

        await interaction.editReply({
          content: `✅ Carga finalizada: \`${pl.name}\` (${addedCount} canciones añadidas exitosamente).`,
        }).catch(() => {});

        client.playlistLoading.delete(interaction.guild.id);
      })();

      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
    } catch (e) {
      client.logger.error("Error al reproducir lista guardada:", e);
      return client.embed(interaction, `${client.config.emoji.ERROR} Error: ${e.message}`);
    }
  },
  autocomplete: async (client, interaction) => {
    const focused = interaction.options.getFocused()?.toLowerCase?.() || "";
    const alls = await Store.getAll(client, interaction.guild.id, interaction.user.id);
    const choices = alls.map((p) => p.name).filter(Boolean);
    const filtered = choices.filter((c) => c.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map((n) => ({ name: n, value: n })));
  },
};
