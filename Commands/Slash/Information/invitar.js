const {
  CommandInteraction,
  ApplicationCommandType,
  PermissionFlagsBits,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "invitar",
  name_localizations: {
    "en-US": "invite",
    "en-GB": "invite",
  },
  description: `¡Obtén mi enlace de invitación para añadirme!`,
  description_localizations: {
    "en-US": "Get the bot's invitation link",
    "en-GB": "Get the bot's invitation link",
  },
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Information",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,

  /**
   *
   * @param {MusicBot} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    // Code
    const invite = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=6508997968&scope=bot%20applications.commands`;
    client.embed(interaction, `[\`Haz clic para invitarme\`](${invite})`);
  },
};
