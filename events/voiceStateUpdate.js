const { ChannelType, Colors, Events } = require("discord.js");
const client = require("../index");
const { msToDuration } = require("../handlers/functions");
const UserHistory = require("../handlers/UserHistory");

const leaveTimeout = client.config.options.leaveTimeout;

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!newState || !newState.guild || !newState.member || newState.member.user.bot) return;

  const guildId = newState.guildId || newState.guild.id;
  const queue = client.distube.getQueue(guildId);

  // Auto speak in stage channel
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
      const isNoSuggest = await UserHistory.isNoSuggestions(client, guildId, newState.member.id);
      if (!isNoSuggest) {
        const embed = await UserHistory.buildPreviewEmbed(client, guildId, newState.member.id);
        if (embed) {
          const textChannel = await newState.guild.channels.fetch("432435342738456590").catch(() => null);
          if (textChannel) {
            const components = await UserHistory.buildPreviewComponents(client, guildId, newState.member.id);
            const msg = await textChannel.send({
              content: `<@${newState.member.id}>`,
              embeds: [embed],
              components,
            }).catch(() => null);
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

  if (!queue) return;
  const textChannel = queue.textChannel;
  const db = textChannel
    ? await client.music?.get(`${textChannel.guildId}.vc`)
    : null;

  // 24/7 music system
  try {
    const twentyFourSevenEnabled = db?.enable;

    if (!twentyFourSevenEnabled && oldState.channel && !newState.channel) {
      // If not in 24/7 mode and someone leaves the voice channel
      const channel = queue.voiceChannel;
      if (!channel) return;

      const members = channel.members.filter((m) => !m.user.bot);

      if (members.size < 1) {
        if (textChannel) {
          const msg = await textChannel.send({
            embeds: [
              {
                description: `I will leave the voice channel in \`${msToDuration(
                  leaveTimeout
                )}\` if 24/7 mode is not enabled.`,
                color: Colors.Red,
              },
            ],
          });
          setTimeout(() => msg.delete().catch(() => {}), 3000);
        }

        const leaveTimeoutHandle = setTimeout(async () => {
          try {
            await queue.stop();
            if (textChannel) await client.editPlayerMessage(textChannel);
            if (textChannel) {
              const leaveMsg = await textChannel.send({
                embeds: [
                  {
                    description: "I left the voice channel because I was alone.",
                    color: Colors.Red,
                  },
                ],
              });
              setTimeout(() => leaveMsg.delete().catch(() => {}), 3000);
            }
          } catch (error) {
            console.error("Error stopping queue after leave timeout:", error);
          }
        }, leaveTimeout);

        client.leaveTimeoutHandles.set(guildId, leaveTimeoutHandle);
      }
    }

    // Clear leave timeout if someone joins the voice channel
    if (!twentyFourSevenEnabled && !oldState.channel && newState.channel) {
      const leaveTimeoutHandle = client.leaveTimeoutHandles.get(guildId);
      if (leaveTimeoutHandle) {
        clearTimeout(leaveTimeoutHandle);
        client.leaveTimeoutHandles.delete(guildId);
      }
    }
  } catch (error) {
    console.log(`24/7 System Error: `, error);
  }
});
