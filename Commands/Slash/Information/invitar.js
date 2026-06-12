const {
  CommandInteraction,
  ApplicationCommandType,
  PermissionFlagsBits,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");
const { links } = require("../../../settings/config");

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
   * @param {JUGNU} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    // Code
    client.embed(
      interaction,
      `[\`Haz clic para invitarme\`](${links.inviteURL.replace(
        "BOTID",
        client.user.id
      )})`
    );
  },
};
