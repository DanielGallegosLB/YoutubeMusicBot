const { ChannelType, Events } = require("discord.js");
const client = require("../index");
const UserHistory = require("../handlers/UserHistory");
const {
  maybeScheduleLeave,
  cancelLeave,
} = require("../handlers/EmptyChannelLeave");
const { stopMarqueeActivity } = require("../handlers/ActivityManager");

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!newState || !newState.guild || !newState.member) return;

  const guild = newState.guild;
  const guildId = guild.id;

  // --- The bot's own voice state changes ---
  if (newState.member.id === client.user.id) {
    if (oldState.channelId && !newState.channelId) {
      // The bot left a voice channel (kicked, disconnected, or after stop/leave).
      // Cancel any pending leave timer and reset the stuck activity/nickname.
      try {
        cancelLeave(client, guildId);
      } catch {}
      try {
        stopMarqueeActivity(client, guild);
      } catch {}
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
          const textChannel = await newState.guild.channels
            .fetch("432435342738456590")
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
