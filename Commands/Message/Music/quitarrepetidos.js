const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "quitarrepetidos",
  aliases: ["rmdupes", "rmd", "removedupes"],
  description: `Quita las canciones repetidas de la cola`,
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: true,
  djOnly: true,

  /**
   *
   * @param {MusicBot} client
   * @param {Message} message
   * @param {String[]} args
   * @param {String} prefix
   * @param {Queue} queue
   */
  run: async (client, message, args, prefix, queue) => {
    // Code
    const seen = new Set();
    const kept = [];
    for (const track of queue.songs) {
      const key = track?.url || `${track?.name || ""}|${track?.duration || 0}`;
      if (!seen.has(key)) {
        seen.add(key);
        kept.push(track);
      }
    }
    const removed = queue.songs.length - kept.length;
    queue.songs = kept;
    client.updatequeue(queue).catch(() => {});
    client.updateplayer(queue).catch(() => {});
    client.embed(
      message,
      `** ${client.config.emoji.SUCCESS} Removed 🎧 \`${removed}\` Duplicate Songs From Queue **`
    );
  },
};
