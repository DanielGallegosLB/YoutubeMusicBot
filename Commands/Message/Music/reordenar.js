const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "reordenar",
  aliases: ["reorder", "moveq"],
  description: `Mueve una canción de la lista a una nueva posición`,
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
    const from = parseInt(args[0]);
    const to = parseInt(args[1]);

    if (isNaN(from) || isNaN(to) || from < 1 || to < 1 || from >= queue.songs.length || to >= queue.songs.length) {
      return client.embed(
        message,
        `${client.config.emoji.ERROR} Uso: \`${prefix}reordenar <posición_actual> <nueva_posición>\`\nEjemplo: \`${prefix}reordenar 5 1\` (mueve la canción 5 a la posición 1).`
      );
    }

    if (from === to) return client.embed(message, `${client.config.emoji.ERROR} La canción ya está en esa posición.`);

    const song = queue.songs[from];
    queue.songs.splice(from, 1);
    queue.songs.splice(to, 0, song);

    client.embed(
      message,
      `${client.config.emoji.SUCCESS} Se ha movido **${client.getTitle(song)}** de la posición \`${from}\` a la \`${to}\`.`
    );
  },
};
