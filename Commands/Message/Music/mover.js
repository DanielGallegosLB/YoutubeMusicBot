const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "mover",
  aliases: ["mv", "nvs", "move"],
  description: `Mueve una canción en la cola`,
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
    let songIndex = Number(args[0]);
    let position = Number(args[1]);
    if (!Number.isInteger(songIndex) || !Number.isInteger(position)) {
      return client.embed(
        message,
        `${client.config.emoji.ERROR} Wrong Usage :: ${prefix}move <songindex> <targetindex>`
      );
    }
    if (songIndex < 1 || songIndex >= queue.songs.length) {
      return client.embed(
        message,
        ` **The last Song in the Queue has the Index: \`${queue.songs.length - 1}\`**`
      );
    } else if (position < 1) {
      return client.embed(message, `**Cannot move Song before Playing Song!**`);
    } else {
      let song = queue.songs[songIndex];
      //remove the song
      queue.songs.splice(songIndex, 1);
      //Add it to a specific Position
      let target = Math.floor(position);
      if (target > queue.songs.length) target = queue.songs.length;
      queue.songs.splice(target, 0, song);
      client.updatequeue(queue).catch(() => {});
      client.updateplayer(queue).catch(() => {});
      client.embed(
        message,
        `📑 Moved **${client.getTitle(
          song
        )}** to the **\`${target}th\`** Place right after **_${
          queue.songs[target - 1]?.name || "Unknown"
        }_!**`
      );
    }
  },
};
