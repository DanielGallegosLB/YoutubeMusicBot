const { Events } = require("discord.js");
const MusicBot = require("./Client");
const { PREFIX: botPrefix } = require("../settings/config");

/**
 *
 * @param {MusicBot} client
 */
module.exports = async (client) => {
  client.on(Events.MessageCreate, async (message) => {
    try {
      // Only handle guild messages
      if (!message.guild || !message.id) return;

      const guildId = message.guild.id;
      const data = await client.music?.get(`${guildId}.music`);

      // If music data for the guild doesn't exist, return
      if (!data) return;

      const musicChannelId = data.channel;
      const musicChannel = message.guild.channels.cache.get(musicChannelId);

      // If music channel doesn't exist or message is not in the music channel, return
      if (!musicChannel || message.channelId !== musicChannelId) return;

      // Leave bot messages and the protected queue/player messages alone
      if (message.author.bot) return;
      if (data.pmsg === message.id || data.qmsg === message.id || client.previewMessages?.has(message.id)) return;

      // Songs are only added through explicit play commands (!play, /reproducir, etc.).
      // Detect command messages (bot prefix or mention) and leave them to the command handler.
      const settings = message.guild.id ? await client.music.get(message.guild.id).catch(() => null) : null;
      const prefix = settings?.prefix || botPrefix;
      const commandPattern = new RegExp(`^(<@!?${client.user.id}>|${escapeRegex(prefix)})\\s*`);
      if (commandPattern.test(message.content)) return;

      // Everything else is not a valid song request: delete it and discard it.
      await message.delete().catch(() => {});
      const hint = await message.channel
        .send({
          content: `ℹ️ Para añadir música usa \`${prefix}play <cancion o enlace>\` o \`/reproducir <cancion o enlace>\`.`,
        })
        .catch(() => null);
      if (hint) setTimeout(() => hint.delete().catch(() => {}), 5000);
    } catch (error) {
      client.logger.error("Error handling message in RequestChannel:", error);
    }
  });
};

function escapeRegex(newprefix) {
  return newprefix.replace(/[.*+?${}()|[\]\\]/g, `\\$&`);
}