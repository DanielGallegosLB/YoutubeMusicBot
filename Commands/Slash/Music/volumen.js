const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "volumen",
  description: `Cambia el volumen del bot`,
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: true,
  djOnly: true,
  options: [
    {
      name: "cantidad",
      description: `El nivel de volumen (1-150)`,
      type: ApplicationCommandOptionType.Number,
      required: true,
    },
  ],
  /**
   *
   * @param {JUGNU} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    // Code
    let volume = interaction.options.getNumber("cantidad");
    if (volume > 250) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR} Provide Volume Amount Between 1 - 250  !!`
      );
    } else {
      await queue.setVolume(volume);
      client.embed(
        interaction,
        `${client.config.emoji.SUCCESS} Volume Set to ${queue.volume}% !!`
      );
    }
  },
};
