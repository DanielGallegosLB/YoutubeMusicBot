const { PermissionFlagsBits, Events } = require("discord.js");
const MusicBot = require("./Client");

/**
 *
 * @param {MusicBot} client
 */
module.exports = async (client) => {
  client.on(Events.MessageCreate, async (message) => {
    try {
      // Check if the message is in a guild and has an ID
      if (!message.guild || !message.id) return;

      const guildId = message.guild.id;
      const data = await client.music?.get(`${guildId}.music`);

      // If music data for the guild doesn't exist, return
      if (!data) return;

      const musicChannelId = data.channel;
      const musicChannel = message.guild.channels.cache.get(musicChannelId);

      // If music channel doesn't exist or message is not in the music channel, return
      if (!musicChannel || message.channelId !== musicChannelId) return;

      // Check if the bot has permission to manage messages
      if (
        !message.guild.members.me.permissions.has(
          PermissionFlagsBits.ManageMessages
        )
      ) {
        return client.embed(
          message,
          `** ${client.config.emoji.ERROR} I don't Have Permission to \`ManageMessages\` in ${musicChannel} **`
        );
      }

      // Delete the message if it's not related to music commands or a protected preview message
      if (data.pmsg !== message.id && data.qmsg !== message.id && !client.previewMessages?.has(message.id)) {
        await message.delete().catch(console.error);
      }

      // If message author is a bot, return
      if (message.author.bot) return;

      const song = message.cleanContent;
      const voiceChannel = message.member.voice.channel;

      // Check if the bot has permission to connect to voice channels
      if (
        !message.guild.members.me.permissions.has(PermissionFlagsBits.Connect)
      ) {
        return client.embed(
          message,
          `** ${client.config.emoji.ERROR} I don't Have Permission to Join Voice Channel **`
        );
      }

      // Check if the user is in a voice channel
      if (!voiceChannel) {
        return client.embed(
          message,
          `** ${client.config.emoji.ERROR} You Need to Join Voice Channel **`
        );
      }

      // Check if the bot is already in a different voice channel
      if (
        message.guild.members.me.voice.channel &&
        !message.guild.members.me.voice.channel.equals(voiceChannel)
      ) {
        return client.embed(
          message,
          `** ${client.config.emoji.ERROR} You Need to Join __MY__ Voice Channel **`
        );
      }

      const query = song;

      client.logger.log(`[RequestChannel] Play request from ${message.author.tag} in ${message.guild.name}: ${song}`);

      // Play the song in the user's voice channel
      await client.distube.play(voiceChannel, query, {
        member: message.member,
        message: message,
        textChannel: message.channel,
      });
    } catch (error) {
      client.logger.error("Error handling message in RequestChannel:", error);
    }
  });
};
