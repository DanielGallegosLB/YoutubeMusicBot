const { Events } = require("discord.js");
const MusicBot = require("./Client");

const SWEEP_INTERVAL = 5 * 60 * 1000;
const MESSAGE_TTL = 5 * 60 * 1000;
const MAX_MESSAGES = 100;

/**
 * Keeps the configured music/requests channel clean so transient messages
 * (confirmations, ephemeral replies, etc.) never pile up and the ephemeral
 * feedback the user depends on stays easy to see.
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
        const data = await client.music?.get(`${guild.id}.music`);
        if (!data || !data.channel) continue;

        const channel = guild.channels.cache.get(data.channel);
        if (!channel || !channel.isTextBased() || !channel.viewable) continue;

        const protectedIds = new Set(
          [data.pmsg, data.qmsg].filter(Boolean)
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
      } catch (error) {
        /* keep sweeping other guilds */
      }
    }
  };

  client.once(Events.ClientReady, () => setTimeout(sweep, 10000));
  setInterval(sweep, SWEEP_INTERVAL);
};