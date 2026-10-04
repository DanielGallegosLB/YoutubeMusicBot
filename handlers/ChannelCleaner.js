const { Events } = require("discord.js");
const MusicBot = require("./Client");

const SWEEP_INTERVAL = 5 * 60 * 1000;
const MESSAGE_TTL = 5 * 60 * 1000;
const MAX_MESSAGES = 100;
// Tope para las lecturas a la base: si el store se cuelga (lock, reconexión),
// el sweep no puede congelar el intervalo ni el event loop del bot.
const withTimeout = (p, ms) =>
  Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r(null), ms))]);

/**
 * Keeps the cleanup channels (settings/config.js channels.cleanup) tidy so
 * transient messages (confirmations, slash replies, ephemeral feedback, etc.)
 * never pile up and the controls the user needs stay easy to reach.
 *
 * Channels listed in channels.noCleanup are NEVER touched, not even an
 * ephemeral reply; the player channel joins the cleanup list automatically
 * unless the guild marked it as untouchable.
 *
 * Protected from deletion:
 *   - the player and queue embeds (data.pmsg / data.qmsg)
 *   - pinned messages
 *   - the now-playing preview messages (client.previewMessages)
 *
 * @param {MusicBot} client
 */
module.exports = async (client) => {
  const sweep = async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const data = await withTimeout(client.music?.get(`${guild.id}.music`), 3000);
        const policy = await withTimeout(client.getChannelPolicy(guild.id), 3000);
        if (!policy?.cleanup?.length) continue;

        for (const channelId of policy.cleanup) {
          if (policy.noCleanup.includes(String(channelId))) continue;

          const channel = guild.channels.cache.get(String(channelId));
          if (!channel || !channel.isTextBased() || !channel.viewable) continue;

          const protectedIds = new Set(
            [data?.pmsg, data?.qmsg].filter(Boolean)
          );

          const messages = await channel.messages
            .fetch({ limit: MAX_MESSAGES })
            .catch(() => null);
          if (!messages) continue;

          const now = Date.now();
          for (const msg of messages.values()) {
            if (protectedIds.has(msg.id)) continue;
            if (msg.pinned) continue;
            if (client.previewMessages?.has(msg.id)) continue;
            if (now - msg.createdTimestamp <= MESSAGE_TTL) continue;
            await msg.delete().catch(() => {});
          }
        }
      } catch (error) {
        /* keep sweeping other guilds */
      }
    }
  };

  client.once(Events.ClientReady, () => setTimeout(sweep, 10000));
  setInterval(sweep, SWEEP_INTERVAL);
};