const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "maxcola",
  aliases: ["qlimit", "maxqueue", "maxcanciones"],
  description: `Máximo de canciones a mostrar en la cola`,
  userPermissions: PermissionFlagsBits.ManageGuild,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,

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
    if (!args[0]) {
      const current = await client.music.get(`${message.guild.id}.qlimit`).catch(() => undefined) || 10;
      return client.embed(
        message,
        `${client.config.emoji.SUCCESS} El límite de canciones en la cola es **${current}**.\nÚsalo así: \`${prefix}maxcola <1-50>\``
      );
    }
    const n = Number(args[0]);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return client.embed(
        message,
        `${client.config.emoji.ERROR} Proporciona un número entero entre **1** y **50**.`
      );
    }
    await client.music.set(`${message.guild.id}.qlimit`, n);
    const q = client.distube.getQueue(message.guild.id);
    if (q) client.updatequeue(q).catch(() => {});
    return client.embed(
      message,
      `${client.config.emoji.SUCCESS} Límite de cola configurado a **${n}** canciones.`
    );
  },
};