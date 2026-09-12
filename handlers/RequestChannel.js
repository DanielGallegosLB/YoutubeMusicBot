const { Events, EmbedBuilder, ChannelType } = require("discord.js");
const MusicBot = require("./Client");
const { PREFIX: botPrefix } = require("../settings/config");
const { searchYoutube } = require("./PlaylistFetcher");

// Per-guild promise chain so requests are resolved/queued one by one,
// in the exact order the user posts them — nothing gets dropped.
const requestChains = new Map();

function enqueue(guildId, fn) {
  const prev = requestChains.get(guildId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  requestChains.set(guildId, next);
  next
    .catch(() => {})
    .finally(() => {
      if (requestChains.get(guildId) === next) requestChains.delete(guildId);
    });
  return next;
}

function escapeRegex(str) {
  return str.replace(/[.*+?${}()|[\]\\]/g, `\\$&`);
}

/**
 *
 * @param {MusicBot} client
 */
module.exports = async (client) => {
  client.on(Events.MessageCreate, async (message) => {
    try {
      // Only handle guild messages from humans
      if (!message.guild || !message.id || message.author.bot) return;

      const guildId = message.guild.id;
      const data = await client.music?.get(`${guildId}.music`);
      if (!data) return;

      const musicChannelId = data.channel;
      const musicChannel = message.guild.channels.cache.get(musicChannelId);

      // Only process messages sent in the configured music channel
      if (!musicChannel || message.channelId !== musicChannelId) return;

      // Leave bot messages and the protected queue/player messages alone
      if (data.pmsg === message.id || data.qmsg === message.id || client.previewMessages?.has(message.id)) return;

      // Commands (with prefix or bot mention) are handled by the command handler
      const settings = await client.music.get(guildId).catch(() => null);
      const prefix = settings?.prefix || botPrefix;
      const commandPattern = new RegExp(`^(<@!?${client.user.id}>|${escapeRegex(prefix)})\\s*`);
      if (commandPattern.test(message.content)) return;

      const query = message.content.trim();
      if (!query) return;

      // Serialize processing so every request ends up in the queue in order
      enqueue(guildId, async () => {
        await processRequest(client, message, query);
      });
    } catch (error) {
      client.logger.error("Error handling message in RequestChannel:", error);
    }
  });
};

/**
 * Resolve a song request and add it to the queue (plays it if nothing is running).
 */
async function processRequest(client, message, query) {
  const guild = message.guild;
  const guildId = guild.id;

  // Clear any residual explicit-stop flag so playback can start normally
  client.playlistStopped.delete(guildId);

  // Choose the target voice channel: bot's channel > requester's channel > 24/7 channel
  let channel = guild.members.me?.voice?.channel || message.member?.voice?.channel || null;
  if (!channel) {
    const db = await client.music?.get(`${guildId}.vc`).catch(() => null);
    if (db?.enable && db.channel) {
      channel = guild.channels.cache.get(db.channel);
    }
  }

  if (
    !channel ||
    (channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice)
  ) {
    const hint = await message.channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setDescription(
              `ℹ️ Debes estar en un canal de voz para pedir una canción, o activa el modo 24/7.`
            ),
        ],
      })
      .catch(() => null);
    if (hint) setTimeout(() => hint.delete().catch(() => {}), 5000);
    return;
  }

  const isURL = /^(https?:\/\/)/i.test(query);
  const playOpts = {
    member: message.member,
    textChannel: message.channel,
    message: message,
  };

  let added = false;
  try {
    await client.distube.voices.join(channel);
    await client.distube.play(channel, isURL ? query : `ytsearch1:${query}`, playOpts);
    added = true;
  } catch (e) {
    // Search API failed (common when YouTube blocks search): fall back to yt-dlp search
    if (!isURL) {
      try {
        const resolved = await searchYoutube(query);
        if (resolved) {
          await client.distube.voices.join(channel);
          await client.distube.play(channel, resolved, playOpts);
          added = true;
        }
      } catch (e2) {
        client.logger.error(`[Request] yt-dlp fallback error:`, e2);
      }
    }
  }

  await message.delete().catch(() => {});

  // Confirm so the request never "disappears into nothing"
  const confirm = await message.channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(added ? "#2ECC71" : "#E74C3C")
          .setDescription(
            added
              ? `🎵 **Agregado a la cola:** \`${query.length > 60 ? query.substring(0, 60) + "…" : query}\``
              : `❌ No encontré una canción para: \`${query.length > 60 ? query.substring(0, 60) + "…" : query}\``
          ),
      ],
    })
    .catch(() => null);
  if (confirm) setTimeout(() => confirm.delete().catch(() => {}), 5000);
}