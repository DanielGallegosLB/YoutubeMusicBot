const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "invitar",
  aliases: ["inv", "añadirme", "invite"],
  description: `¡Obtén mi enlace de invitación para añadirme!`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Information",
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
    const invite = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=6508997968&scope=bot%20applications.commands`;
    client.embed(message, `[\`Haz clic para invitarme\`](${invite})`);
  },
};
