const {
  CommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  ApplicationCommandType,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ComponentType,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { Song } = require("distube");
const JUGNU = require("../../../handlers/Client");

const buildStoredSong = (track, guild) => {
  return new Song(
    {
      duration: track.duration,
      formattedDuration: track.formattedDuration,
      id: track.id,
      isLive: track.isLive,
      name: track.name,
      thumbnail: track.thumbnail,
      uploader: track.uploader,
      url: track.url,
      views: track.views,
      source: track.source,
      playFromSource: true,
    },
    { member: guild.members.cache.get(track.memberId) || guild.members.me }
  );
};

module.exports = {
  name: "resumir",
  name_localizations: {
    "en-US": "summary",
    "en-GB": "summary",
  },
  description: `Resume una de las últimas sesiones de música guardadas`,
  description_localizations: {
    "en-US": "Resume one of the last saved music sessions",
    "en-GB": "Resume one of the last saved music sessions",
  },
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Information",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,

  /**
   *
   * @param {JUGNU} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   */
  run: async (client, interaction, args) => {
    try {
      const sessions = (await client.music.get(`${interaction.guildId}.sessions`)) || [];
      const replyWith = async (payload) =>
        interaction.deferred || interaction.replied
          ? await interaction.editReply(payload)
          : await interaction.reply(payload);

      if (!sessions.length) {
        return replyWith({
          content: `❌ No hay sesiones de música guardadas para este servidor.`,
          ephemeral: true,
        });
      }

      const lastSessions = sessions.slice(0, 3);
      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("resumir_session_select")
          .setPlaceholder("Selecciona una sesión para ver o recuperar")
          .addOptions(
            lastSessions.map((session) => ({
              label: session.title.slice(0, 100),
              description: `${session.count} canciones • ${new Date(session.createdAt).toLocaleDateString("es-ES")}`,
              value: session.id,
            }))
          )
      );

      const replyData = {
        content: "📋 **Selecciona una sesión de música anterior:**",
        components: [selectRow],
        ephemeral: true,
      };

      const replyMsg = interaction.deferred || interaction.replied
        ? await interaction.editReply(replyData)
        : await interaction.reply({ ...replyData, fetchReply: true });

      const filter = (i) => i.user.id === interaction.user.id;
      let sessionSelected = false;
      const collector = replyMsg.createMessageComponentCollector({
        filter,
        componentType: ComponentType.StringSelect,
        time: 60000,
      });

      collector.on("collect", async (selectInteraction) => {
        sessionSelected = true;
        const selectedId = selectInteraction.values[0];
        const selectedSession = sessions.find((s) => s.id === selectedId);
        if (!selectedSession) {
          return selectInteraction.reply({
            content: "❌ Sesión no encontrada.",
            ephemeral: true,
          });
        }

        const tracksPreview = selectedSession.songs
          .slice(0, 5)
          .map((song, index) => `
**${index + 1}.** [${song.name}](${song.url}) • ${song.formattedDuration}`)
          .join("\n");

        const embed = new EmbedBuilder()
          .setColor(client.config.embed.color)
          .setTitle(selectedSession.title)
          .setDescription(`**Solicitado por:** ${selectedSession.requestedBy}
**Tipo:** ${selectedSession.source}
**Canciones:** ${selectedSession.count}
**Guardado:** ${new Date(selectedSession.createdAt).toLocaleString("es-ES")}
${selectedSession.truncated ? "\n**Nota:** sesión truncada a los primeros 150 tracks." : ""}`)
          .addFields([
            {
              name: "Vista previa",
              value: tracksPreview || "No hay canciones guardadas en esta sesión.",
            },
          ])
          .setFooter({ text: `ID: ${selectedSession.id}` })
          .setTimestamp(new Date(selectedSession.createdAt));

        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`resumir_resume_${selectedSession.id}`)
            .setLabel("Recuperar sesión")
            .setStyle(ButtonStyle.Primary)
        );

        await selectInteraction.update({ embeds: [embed], components: [buttonRow], content: "" });

        const buttonCollector = selectInteraction.message.createMessageComponentCollector({
          filter,
          componentType: ComponentType.Button,
          time: 60000,
        });

        buttonCollector.on("collect", async (buttonInteraction) => {
          if (buttonInteraction.customId !== `resumir_resume_${selectedSession.id}`) return;

          await buttonInteraction.deferReply({ ephemeral: true }).catch(() => {});

          const member = interaction.member;
          const guild = interaction.guild;
          const voiceChannel = member.voice.channel;
          if (!voiceChannel) {
            return buttonInteraction.editReply({
              content: "❌ Debes estar en un canal de voz para recuperar la sesión.",
            });
          }

          const botVoice = guild.members.me.voice.channel;
          if (botVoice && botVoice.id !== voiceChannel.id) {
            return buttonInteraction.editReply({
              content: "❌ El bot ya está en otro canal de voz.",
            });
          }

          const storedSongs = selectedSession.songs.map((track) => buildStoredSong(track, guild));
          if (!storedSongs.length) {
            return buttonInteraction.editReply({
              content: "❌ Esta sesión no contiene canciones recuperables.",
            });
          }

          let queue = client.distube.getQueue(guild.id);
          try {
            if (!queue || !queue.songs.length) {
              await client.distube.voices.join(voiceChannel);
              await client.distube.play(voiceChannel, selectedSession.songs[0].url, {
                member,
                textChannel: interaction.channel,
              });
              queue = client.distube.getQueue(guild.id);
              if (storedSongs.length > 1) {
                queue.addToQueue(storedSongs.slice(1));
              }
            } else {
              queue.addToQueue(storedSongs, 1);
            }

            await buttonInteraction.editReply({
              content: `✅ Sesión recuperada: ${storedSongs.length} canciones añadidas.`,
            });
            buttonCollector.stop();
          } catch (error) {
            client.logger.error(`[Resumir] Error al recuperar sesión:`, error);
            await buttonInteraction.editReply({
              content: `❌ Error al recuperar la sesión: ${error.message}`,
            });
          }
        });

        buttonCollector.on("end", () => {
          selectInteraction.message.edit({ components: [] }).catch(() => {});
        });

      });

      collector.on("end", () => {
        if (!sessionSelected) {
          replyMsg.edit({ components: [] }).catch(() => {});
        }
      });
    } catch (e) {
      client.logger.error(`[Resumir Error]`, e);
      await interaction.followUp({
        content: `❌ Error al obtener resumen: ${e.message}`,
        ephemeral: true,
      });
    }
  },
};
