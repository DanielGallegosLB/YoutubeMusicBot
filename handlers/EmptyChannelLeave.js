const { Colors } = require("discord.js");
const { msToDuration } = require("./functions");
const { stopMarqueeActivity } = require("./ActivityManager");

/**
 * Cancels a pending "leave empty channel" timer for a guild.
 * @param {import("./Client")} client
 * @param {string} guildId
 */
function cancelLeave(client, guildId) {
  const timer = client.leaveTimeoutHandles?.get(guildId);
  if (timer) {
    clearTimeout(timer);
    client.leaveTimeoutHandles.delete(guildId);
  }
}

/**
 * Leaves the voice channel immediately: clears queue, resets activity/nickname
 * and disconnects the bot. Safe to call even if nothing is playing.
 * @param {import("./Client")} client
 * @param {import("discord.js").Guild} guild
 */
async function leaveGuild(client, guild) {
  cancelLeave(client, guild.id);
  try {
    stopMarqueeActivity(client, guild);
  } catch {}
  try {
    const q = client.distube.getQueue(guild.id);
    if (q) {
      if (client.actualPlaying) client.actualPlaying.delete(guild.id);
      q.songs = [];
      await q.stop().catch(() => {});
    }
  } catch {}
  try {
    await client.distube.voices.leave(guild);
  } catch {}
  try {
    if (client.actualPlaying) client.actualPlaying.delete(guild.id);
    await client.autoresume?.delete(guild.id).catch(() => {});
  } catch {}
}

/**
 * Schedules the bot to leave the voice channel if it is the only one left
 * (no human members) and 24/7 mode is disabled. Requires no active queue —
 * works even when DisTube already deleted the empty queue.
 * @param {import("./Client")} client
 * @param {import("discord.js").Guild} guild
 * @returns {Promise<boolean>} true if a leave timer was scheduled/already active
 */
async function maybeScheduleLeave(client, guild) {
  const guildId = guild.id;
  const me = guild.members.me;
  if (!me?.voice?.channel) return false;

  const hasHumans = me.voice.channel.members.some((m) => !m.user.bot);
  if (hasHumans) return false;

  const db = await client.music?.get(`${guildId}.vc`).catch(() => null);
  if (db?.enable) return false;

  if (client.leaveTimeoutHandles?.has(guildId)) return true;

  const leaveTimeout = client.config.options.leaveTimeout;

  const data = await client.music?.get(`${guildId}.music`).catch(() => null);
  const textChannel = data?.channel
    ? guild.channels.cache.get(data.channel)
    : null;

  if (
    textChannel &&
    textChannel.permissionsFor(guild.members.me)?.has("SendMessages")
  ) {
    const msg = await textChannel
      .send({
        embeds: [
          {
            description: `I will leave the voice channel in \`${msToDuration(
              leaveTimeout
            )}\` if 24/7 mode is not enabled.`,
            color: Colors.Red,
          },
        ],
      })
      .catch(() => null);
    if (msg) setTimeout(() => msg.delete().catch(() => {}), 3000);
  }

  const timer = setTimeout(async () => {
    try {
      client.leaveTimeoutHandles?.delete(guildId);

      const q = client.distube.getQueue(guildId);
      const wasPlaying = !!q;

      stopMarqueeActivity(client, guild);

      if (q) {
        if (client.actualPlaying) client.actualPlaying.delete(guildId);
        q.songs = [];
        await q.stop().catch(() => {});
      }
      await client.autoresume?.delete(guildId).catch(() => {});
      if (client.actualPlaying) client.actualPlaying.delete(guildId);
      client.distube.voices.leave(guild);
      await client.updateembed(client, guild).catch(() => {});
      if (textChannel) {
        await client.editPlayerMessage(textChannel).catch(() => {});
      }

      if (textChannel && (wasPlaying || textChannel)) {
        const leaveMsg = await textChannel
          .send({
            embeds: [
              {
                description: "I left the voice channel because I was alone.",
                color: Colors.Red,
              },
            ],
          })
          .catch(() => null);
        if (leaveMsg) setTimeout(() => leaveMsg.delete().catch(() => {}), 3000);
      }
    } catch (error) {
      console.error("[EmptyChannelLeave] Error leaving empty channel:", error);
    }
  }, leaveTimeout);

  client.leaveTimeoutHandles.set(guildId, timer);
  return true;
}

module.exports = { maybeScheduleLeave, cancelLeave, leaveGuild };