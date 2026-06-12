const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "siempreactivo",
  name_localizations: {
    "en-US": "247",
    "en-GB": "247",
  },
  description: `Activa o desactiva el modo 24/7`,
  description_localizations: {
    "en-US": "Toggle 24/7 mode on or off",
    "en-GB": "Toggle 24/7 mode on or off",
  },
  userPermissions: PermissionFlagsBits.ManageGuild,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Settings",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
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
    let data = await client.music.get(`${interaction.guild.id}.vc`);
    let mode = data?.enable;
    let channel = interaction.member.voice.channel;

    if (mode === true) {
      let dataOptions = {
        enable: false,
        channel: null,
      };
      await client.music.set(`${interaction.guild.id}.vc`, dataOptions);
      // if (player) await player.destroy();
      client.embed(
        interaction,
        `** ${client.config.emoji.ERROR}  24/7 System Disabled **`
      );
    } else {
      let dataOptions = {
        enable: true,
        channel: channel.id,
      };
      await client.music.set(`${interaction.guild.id}.vc`, dataOptions);
      client.embed(
        interaction,
        `** ${client.config.emoji.SUCCESS} 24/7 System Enabled **`
      );
    }
  },
};
