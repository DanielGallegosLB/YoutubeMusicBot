const {
  CommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  ApplicationCommandType,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ComponentType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");

module.exports = {
  name: "resumir",
  description: `Resume una de las últimas 3 sesiones de desarrollo`,
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
      // Obtener resumen de las últimas 3 sesiones
      const summaries = [
        {
          id: "session_3",
          title: "Sesión 3: Arreglo de Playlist y URL",
          date: "30 de Mayo, 2026",
          description: `
**Problemas resueltos:**
• ❌ Botón de pausa no funcionaba (doble deferUpdate())
• ❌ Las canciones de playlist no continuaban después de la primera
• ❌ Error YTDLP con URLs de YouTube con parámetros extra

**Soluciones aplicadas:**
• ✅ Eliminé manejo duplicado de botones en interactionCreate.js
• ✅ Implementé concurrencia limitada (lotes de 5) en reproducir.js
• ✅ Agregué normalización de URLs de YouTube en 3 comandos
• ✅ Arreglé la función send() en DistubeHandler.js

**Estado actual:**
🟢 Bot se inicia correctamente
🟢 Botones responden adecuadamente
🟢 Reproducción de playlists mejorada
🟢 URLs limpias sin parámetros innecesarios
          `,
        },
        {
          id: "session_2",
          title: "Sesión 2: Optimización de Carga de Playlists",
          date: "28 de Mayo, 2026",
          description: `
**Objetivos alcanzados:**
• Reproducción inmediata de primera canción
• Carga de resto en paralelo sin delays
• Eliminación de sistema de caché

**Cambios principales:**
• ✅ Implementé Promise.allSettled() para cargas paralelas
• ✅ Removí delays de 400ms entre tracks
• ✅ Optimicé reproducir.js, saltaryreproducir.js, reproducirprimero.js
• ✅ Canción toca mientras el resto carga en background

**Resultados:**
✨ Playlists de 100+ canciones cargan sin delays
✨ Primera canción suena inmediatamente
✨ Mejor experiencia de usuario
          `,
        },
        {
          id: "session_1",
          title: "Sesión 1: Inicialización y Errores Críticos",
          date: "28 de Mayo, 2026",
          description: `
**Errores corregidos:**
• ❌ RequestChannel undefined client.music
• ❌ get-intrinsic strict mode violation
• ❌ Null client.user reference
• ❌ Undefined client.logger
• ❌ Missing playlistLoading collection

**Parches aplicados:**
• ✅ Reordenamiento de handler loading
• ✅ Parche a node_modules/get-intrinsic/index.js
• ✅ Optional chaining en Database.js
• ✅ Logger initialization en Client.js
• ✅ Collection para playlistLoading

**Validación:**
✔️ Bot startup sin errores
✔️ Handlers inicializados correctamente
✔️ Database y RequestChannel funcionales
          `,
        },
      ];

      // Crear select menu con las sesiones
      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("session_select")
          .setPlaceholder("Selecciona una sesión para resumir")
          .addOptions(
            summaries.map((s) => ({
              label: s.title,
              description: `${s.date}`,
              value: s.id,
            }))
          )
      );

      const selectMsg = await interaction.followUp({
        content: "📋 **Selecciona una sesión para ver el resumen:**",
        components: [selectRow],
        ephemeral: true,
      });

      // Crear collector para la selección
      const filter = (i) => i.user.id === interaction.user.id;
      const collector = selectMsg.createMessageComponentCollector({
        filter,
        componentType: ComponentType.StringSelect,
        time: 60000,
      });

      collector.on("collect", async (selectInteraction) => {
        const selectedId = selectInteraction.values[0];
        const selectedSession = summaries.find((s) => s.id === selectedId);

        if (!selectedSession) {
          await selectInteraction.reply({
            content: "❌ Sesión no encontrada",
            ephemeral: true,
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(client.config.embed.color)
          .setTitle(selectedSession.title)
          .setDescription(selectedSession.description)
          .setFooter({
            text: `Fecha: ${selectedSession.date}`,
            iconURL: client.user.displayAvatarURL(),
          })
          .setTimestamp();

        await selectInteraction.reply({
          embeds: [embed],
          ephemeral: true,
        });

        collector.stop();
      });

      collector.on("end", () => {
        selectMsg.edit({ components: [] }).catch(() => {});
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
