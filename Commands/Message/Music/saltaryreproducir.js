const { Message, PermissionFlagsBits } = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "saltaryreproducir",
  aliases: ["ps", "pskip", "skipandplay"],
  description: `Salta la canción actual y reproduce una nueva`,
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: false,
  djOnly: true,

  /**
   *
   * @param {JUGNU} client
   * @param {Message} message
   * @param {String[]} args
   * @param {String} prefix
   * @param {Queue} queue
   */
  run: async (client, message, args, prefix, queue) => {
    // Code
    const song = args.join(" ");

    if (!song) {
      return client.embed(
        message,
        `${client.config.emoji.ERROR} Por favor, proporciona el nombre o enlace de una canción.`
      );
    } else {
      let { channel } = message.member.voice;
      const hqStored = await client.music.get(`${message.guildId}.hqmode`);
      const hqMode =
        (hqStored === undefined ? process.env.HQ_MODE === "true" : hqStored) ||
        false;
      // Pre-join voice to parallelize Discord voice handshake with search/resolve
      try {
        await client.distube.voices.join(channel);
      } catch {}
      // If not a URL, use yt-dlp single-result search for faster resolution
      const isURL = /^(https?:\/\/)/i.test(song);
      const query = isURL ? song : `ytsearch1:${song}`;
      await client.distube.play(channel, query, {
        member: message.member,
        textChannel: message.channel,
        message: message,
        skip: true,
        // Keep transforms off in HQ mode for Opus passthrough where possible
        // (Filters/volume adjustments force re-encode)
        // DisTube handles format selection internally; HQ_MODE is a hint not to alter audio
        // You can still toggle filters separately via existing commands
        // eslint-disable-next-line no-unused-vars
        ...(hqMode ? { volume: 100 } : {}),
      });

      await message.delete().catch((err) => {});
    }
  },
};
