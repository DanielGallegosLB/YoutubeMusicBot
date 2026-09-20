const {
  CommandInteraction,
  ChannelType,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "configurarmusica",
  name_localizations: {
    "en-US": "musicsetup",
    "en-GB": "musicsetup",
  },
  description: `Configura el canal de música`,
  description_localizations: {
    "en-US": "Set up the music channel",
    "en-GB": "Set up the music channel",
  },
  userPermissions: PermissionFlagsBits.ManageChannels,
  botPermissions: PermissionFlagsBits.ManageChannels,
  category: "Settings",
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
    let channel = await client.music.get(
      `${interaction.guild.id}.music.channel`
    );
    let oldChannel = interaction.guild.channels.cache.get(channel);

    if (oldChannel) {
      return client.embed(
        interaction,
        `** ${client.config.emoji.ERROR} El panel de música ya está configurado en ${oldChannel}. Elimínalo antes de configurarlo de nuevo. **`
      );
    } else {
      interaction.guild.channels
        .create({
          name: `🎵〡panel-de-musica`,
          type: ChannelType.GuildText,
          rateLimitPerUser: 3,
          reason: `Gestión del panel de música.`,
          topic: `🎵 Panel de música: envía el nombre o el enlace de una canción para pedirla.`,
          permissionOverwrites: [
            {
              id: client.user.id,
              allow: [
                "ManageMessages",
                "ManageChannels",
                "SendMessages",
                "EmbedLinks",
                "ReadMessageHistory",
                "UseExternalEmojis",
                "ViewChannel",
                "CreatePublicThreads",
                "CreatePrivateThreads",
                "SendMessagesInThreads",
              ],
            },
          ],
        })
        .then(async (ch) => {
          await ch
            .send({ embeds: [client.queueembed(interaction.guild)] })
            .then(async (queuemsg) => {
              await ch
                .send({
                  embeds: [client.playembed(interaction.guild)],
                  components: client.buttons(true),
                })
                .then(async (playmsg) => {
                  await client.music.set(`${interaction.guild.id}.music`, {
                    channel: ch.id,
                    pmsg: playmsg.id,
                    qmsg: queuemsg.id,
                  });
                  client.embed(
                    interaction,
                    `${client.config.emoji.SUCCESS} Panel de música configurado correctamente en ${ch}`
                  );
                });
            });
        });
    }
  },
};
