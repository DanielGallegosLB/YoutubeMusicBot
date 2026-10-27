const { ChannelType, Events } = require("discord.js");
const client = require("../index");
const UserHistory = require("../handlers/UserHistory");
const {
  maybeScheduleLeave,
  cancelLeave,
} = require("../handlers/EmptyChannelLeave");
const { stopMarqueeActivity } = require("../handlers/ActivityManager");
const AutoDjPresence = require("../handlers/AutoDjPresence");

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!newState || !newState.guild || !newState.member) return;

  const guild = newState.guild;
  const guildId = guild.id;

  // --- The bot's own voice state changes ---
  if (newState.member.id === client.user.id) {
    // Bot salió del voice
    if (oldState.channelId && !newState.channelId) {
      try {
        cancelLeave(client, guildId);
      } catch {}
      try {
        stopMarqueeActivity(client, guild);
      } catch {}
      return;
    }

    // Bot entró o se movió a un voice (incluye join inicial)
    if (newState.channelId && newState.channelId !== oldState.channelId) {
      try {
        const { isPrivateVoice } = require("../handlers/ActivityManager");
        const vc = newState.channel;
        if (vc && isPrivateVoice(vc) && typeof client.resolvePanelChannel === "function") {
          // Panel fijo → chat de este voice privado (ofuscar uso del bot)
          await client.resolvePanelChannel(guild);
          await client.updateembed(client, guild).catch(() => {});
          // Si ya hay cola, refrescar embeds en el canal nuevo
          const q = client.distube?.getQueue?.(guildId);
          if (q) {
            client.updateplayer?.(q).catch(() => {});
            client.updatequeue?.(q).catch(() => {});
          }
        }
      } catch (e) {
        client.logger?.warn?.(
          `[Voice] No se pudo mover el panel al voice privado: ${e?.message || e}`
        );
      }
    }
    return;
  }

  // Ignore other bots entirely
  if (newState.member.user.bot) return;

  // Auto unsuppress in stage channels
  if (
    newState.channelId &&
    newState.channel?.type === ChannelType.GuildStageVoice &&
    newState.guild?.members?.me?.voice?.suppress
  ) {
    try {
      await newState.guild.members.me.voice.setSuppressed(false);
    } catch (error) {
      console.error("Failed to unsuppress bot's voice:", error);
    }
  }

  // Show playlist preview when a user joins (works with or without active queue)
  if (!oldState.channel && newState.channel) {
    try {
      const isNoSuggest = await UserHistory.isNoSuggestions(
        client,
        guildId,
        newState.member.id
      );
      if (!isNoSuggest) {
        const embed = await UserHistory.buildPreviewEmbed(
          client,
          guildId,
          newState.member.id
        );
if (embed) {
          // Canal de previews configurable (settings/config.js channels.preview).
          const previewChannelId =
            client.config?.channels?.preview || "432435342738456590";
          const textChannel = await newState.guild.channels
            .fetch(previewChannelId)
            .catch(() => null);
          if (textChannel) {
            const components = await UserHistory.buildPreviewComponents(
              client,
              guildId,
              newState.member.id
            );
            const msg = await textChannel
              .send({
                content: `<@${newState.member.id}>`,
                embeds: [embed],
                components,
              })
              .catch(() => null);
            if (msg) {
              client.previewMessages.set(msg.id, true);
            }
          }
        }
      }
    } catch (e) {
      client.logger.error(`[UserHistory] Error showing preview:`, e);
    }
  }

  // --- AutoDJ: si la persona se va del canal del bot, quitar SUS canciones
  //     del AutoDJ de la cola (solo las que el bot le añadió para él) y
  //     reabastecer con los que siguen.
  if (oldState.channelId !== newState.channelId) {
    try {
      const botChannel = guild.members.me?.voice?.channel;
      const wasWithBot = !!botChannel && oldState.channelId === botChannel.id;
      const stillWithBot = !!botChannel && newState.channelId === botChannel.id;
      if (wasWithBot && !stillWithBot) {
        // Activar limpieza al salir (por defecto)
        if (process.env.AUTODJ_REMOVE_ON_LEAVE !== "0") process.env.AUTODJ_REMOVE_ON_LEAVE = "1";
        const removed = await AutoDjPresence.removeUserRecommendations(
          client,
          guild,
          newState.member.id
        );
        if (removed) {
          client.logger.log(
            `[AutoDJ] ${newState.member.user?.tag || newState.member.id} (G:${guildId}) dejó el canal: ${removed} recomendación(es) fuera de la cola.`
          );
        }
      }
    } catch (error) {
      console.log(`AutoDJ presence error: `, error);
    }
  }

  // --- Empty channel handling (works with or without an active Distube queue) ---
  try {
    // Any human voice change: if the bot's channel now has humans, cancel the leave timer.
    const me = guild.members.me;
    if (
      me?.voice?.channel &&
      me.voice.channel.members.some((m) => !m.user.bot)
    ) {
      cancelLeave(client, guildId);
    }

    // A human left a voice channel: if the bot is now alone and 24/7 is off,
    // start the leave timer.
    if (oldState.channelId && !newState.channelId) {
      await maybeScheduleLeave(client, guild);
    }
  } catch (error) {
    console.log(`24/7 System Error: `, error);
  }
});
