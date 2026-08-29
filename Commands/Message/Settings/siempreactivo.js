const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "siempreactivo",
  aliases: ["24vc", "247"],
  description: `Activa o desactiva el modo 24/7`,
  userPermissions: PermissionFlagsBits.ManageGuild,
  botPermissions: PermissionFlagsBits.ManageGuild,
  category: "Settings",
  cooldown: 5,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
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
    let data = await client.music.get(`${message.guild.id}.vc`);
    let mode = data?.enable;
    let channel = message.member.voice.channel;
    if (mode === true) {
      let dataOptions = {
        enable: false,
        channel: null,
      };
      await client.music.set(`${message.guild.id}.vc`, dataOptions);
      // if (player) await player.destroy();
      client.embed(
        message,
        `** ${client.config.emoji.ERROR}  24/7 System Disabled **`
      );
    } else {
      let dataOptions = {
        enable: true,
        channel: channel.id,
      };
      await client.music.set(`${message.guild.id}.vc`, dataOptions);
      client.embed(
        message,
        `** ${client.config.emoji.SUCCESS} 24/7 System Enabled **`
      );
    }
  },
};
