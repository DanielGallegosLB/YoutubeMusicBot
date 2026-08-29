const {
  ContextMenuInteraction,
  ApplicationCommandType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");

module.exports = {
  name: "añadiracola",
  name_localizations: {
    "en-US": "addtoqueue",
    "en-GB": "addtoqueue",
  },
  type: ApplicationCommandType.Message,

  /**
   *
   * @param {MusicBot} client
   * @param {ContextMenuInteraction} interaction
   */
  run: async (client, interaction) => {
    // Code
    let msg = await interaction.channel.messages.fetch(interaction.targetId);
    let song =
      msg.cleanContent || msg.embeds[0].description || msg.embeds[0].title;
    let voiceChannel = interaction.member.voice.channel;
    let botChannel = interaction.guild.members.me.voice.channel;
    if (!msg || !song) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR} No Song found`
      );
    } else if (!voiceChannel) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR} You Need to Join Voice Channel`
      );
    } else if (botChannel && !botChannel?.equals(voiceChannel)) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR} You Need to Join ${botChannel} Voice Channel`
      );
    } else {
      const isURL = /^(https?:\/\/)/i.test(song);
      const query = isURL ? song : `ytsearch1:${song}`;
      await client.distube.play(voiceChannel, query, {
        member: interaction.member,
        textChannel: interaction.channel,
      });
      return client.embed(
        interaction,
        `${client.config.emoji.SUCCESS} Searching \`${song}\` in Universe`
      );
    }
  },
};
