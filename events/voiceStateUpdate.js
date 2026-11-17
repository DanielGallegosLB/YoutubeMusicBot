const { ChannelType, Events } = require("discord.js");
const client = require("../index");
const UserHistory = require("../handlers/UserHistory");
const {
  maybeScheduleLeave,
  cancelLeave,
} = require("../handlers/EmptyChannelLeave");
const { stopMarqueeActivity } = require("../handlers/ActivityManager");
const AutoDjPresence = require("../handlers/AutoDjPresence");

const GRACE_MS = Math.max(0, Number(process.env.AUTODJ_LEAVE_GRACE_MS ?? 30000) || 0);

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!newState || !newState.guild || !newState.member) return;

  const guild = newState.guild;
  const guildId = guild.id;

  // --- The bot's own voice state changes ---
 // --- The bot's own voice state changes ---
  if (newState.member.id === client.user.id) {
    // Bot salió del voice o se desconectó completamente
    if (oldState.channelId && !newState.channelId) {
      try {
        cancelLeave(client, guildId);
      } catch {}
      try {
        stopMarqueeActivity(client, guild);
      } catch {}
      
      // Restaurar panel público si salió de un canal privado
      try {
        const { isPrivateVoice } = require("../handlers/ActivityManager");
        const oldVc = oldState.channel;
        if (oldVc && isPrivateVoice(oldVc) && typeof client.restorePublicPanel === "function") {
          await client.restorePublicPanel(guild);
        }
      } catch (e) {}

      return;
    }

    // Bot entró o se movió a un voice (incluye join inicial)
    if (newState.channelId && newState.channelId !== oldState.channelId) {
      try {
        const { isPrivateVoice } = require("../handlers/ActivityManager");
        const oldVc = oldState.channel;
        const newVc = newState.channel;
        const movedFromPrivate = !!oldVc && isPrivateVoice(oldVc);
        const nowInPrivate   = !!newVc && isPrivateVoice(newVc);

        if (nowInPrivate && typeof client.resolvePanelChannel === "function") {
          await client.resolvePanelChannel(guild);
          await client.updateembed(client, guild).catch(() => {});
          const q = client.distube?.getQueue?.(guildId);
          if (q) {
            client.updateplayer?.(q).catch(() => {});
            client.updatequeue?.(q).catch(() => {});
          }
        } else if (movedFromPrivate && !nowInPrivate && typeof client.restorePublicPanel === "function") {
          // Salió de privado → público: restaurar panel en el canal público original
          await client.restorePublicPanel(guild);
        }
      } catch (e) {
        client.logger?.warn?.(
          `[Voice] Error al gestionar panel al cambiar de canal: ${e?.message || e}`
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
          let textChannel = await newState.guild.channels
            .fetch(previewChannelId)
            .catch(() => null);
          // Voice privado/oculto: "Tus listas guardadas" va al chat de ese voice,
          // no al canal público (si no, delata quién usa el bot y qué escucha).
          try {
            const { isPrivateVoice } = require("../handlers/ActivityManager");
            if (newState.channel && isPrivateVoice(newState.channel)) textChannel = newState.channel;
          } catch (_) {}
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

  // --- Ensordecer / desensordecer en el canal del bot: cambia quién cuenta como oyente,
  //     así que se refresca el embed del orden (el refill ya lo lee en vivo).
  try {
    const bc = guild.members.me?.voice?.channel;
    if (bc && newState.channelId === bc.id && oldState.channelId === newState.channelId
      && (oldState.selfDeaf !== newState.selfDeaf || oldState.serverDeaf !== newState.serverDeaf)) {
      const q = client.distube?.getQueue?.(guildId);
      if (q) client.updatequeue?.(q)?.catch?.(() => {});
    }
  } catch (_) {}

  // --- AutoDJ: si la persona se va del canal del bot, quitar SUS canciones
  //     del AutoDJ de la cola (solo las que el bot le añadió para él) y
  //     reabastecer con los que siguen.
  if (oldState.channelId !== newState.channelId) {
    try {
      const botChannel = guild.members.me?.voice?.channel;
      const wasWithBot = !!botChannel && oldState.channelId === botChannel.id;
      const stillWithBot = !!botChannel && newState.channelId === botChannel.id;
      const timers = client._autoDjLeaveTimers || (client._autoDjLeaveTimers = new Map());
      const tKey = `${guildId}:${newState.member.id}`;
      // Volvió dentro del período de gracia: no se le quita nada.
      if (stillWithBot && timers.has(tKey)) {
        clearTimeout(timers.get(tKey));
        timers.delete(tKey);
        client.logger.log(`[AutoDJ] ${newState.member.user?.tag || newState.member.id} volvió antes de ${Math.round(GRACE_MS / 1000)}s: se conservan sus recomendaciones.`);
      }
      if (wasWithBot && !stillWithBot) {
        // Activar limpieza al salir (por defecto)
        if (process.env.AUTODJ_REMOVE_ON_LEAVE !== "0") process.env.AUTODJ_REMOVE_ON_LEAVE = "1";
        // Período de gracia (AUTODJ_LEAVE_GRACE_MS, 30 s): si vuelve, no se le quitan.
        if (timers.has(tKey)) clearTimeout(timers.get(tKey));
        const uid = newState.member.id;
        const tag = newState.member.user?.tag || uid;
        const t = setTimeout(async () => {
          timers.delete(tKey);
          try {
            const bc = guild.members.me?.voice?.channel;
            const back = bc && bc.members?.has(uid);
            if (back) return;
            const removed = await AutoDjPresence.removeUserRecommendations(client, guild, uid);
            if (removed) {
              client.logger.log(`[AutoDJ] ${tag} (G:${guildId}) no volvió en ${Math.round(GRACE_MS / 1000)}s: ${removed} recomendación(es) fuera de la cola.`);
            }
          } catch (e) { console.log(`AutoDJ grace error: `, e); }
        }, GRACE_MS);
        if (t.unref) t.unref();
        timers.set(tKey, t);
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