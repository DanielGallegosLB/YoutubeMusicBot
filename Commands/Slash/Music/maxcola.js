const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "maxcola",
  name_localizations: {
    "en-US": "maxqueue",
    "en-GB": "maxqueue",
  },
  description: `Establece el máximo de canciones a mostrar en la cola`,
  description_localizations: {
    "en-US": "Set the maximum tracks shown in the queue",
    "en-GB": "Set the maximum tracks shown in the queue",
  },
  userPermissions: PermissionFlagsBits.ManageGuild,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,
  options: [
    {
      name: "cantidad",
      name_localizations: {
        "en-US": "amount",
        "en-GB": "amount",
      },
      description: "Número de canciones a mostrar en la cola (1-50)",
      description_localizations: {
        "en-US": "Number of tracks to show in the queue (1-50)",
        "en-GB": "Number of tracks to show in the queue (1-50)",
      },
      type: ApplicationCommandOptionType.Integer,
      required: false,
    },
  ],

  /**
   *
   * @param {MusicBot} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    // Code
    const n = interaction.options.getInteger("cantidad");
    if (n === null) {
      const current = await client.music.get(`${interaction.guild.id}.qlimit`).catch(() => undefined) || 10;
      return client.embed(
        interaction,
        `${client.config.emoji.SUCCESS} El límite actual de canciones en la cola es **${current}**.`
      );
    }
    if (n < 1 || n > 50) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR} Proporciona un número entero entre **1** y **50**.`
      );
    }
    await client.music.set(`${interaction.guild.id}.qlimit`, n);
    const q = client.distube.getQueue(interaction.guild.id);
    if (q) client.updatequeue(q).catch(() => {});
    return client.embed(
      interaction,
      `${client.config.emoji.SUCCESS} Límite de cola configurado a **${n}** canciones.`
    );
  },
};