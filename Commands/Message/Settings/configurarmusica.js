const { Message, ChannelType, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "configurarmusica",
  aliases: ["setmusic", "setup", "musicsetup"],
  description: `Configura el canal de música`,
  userPermissions: PermissionFlagsBits.ManageGuild,
  botPermissions: PermissionFlagsBits.ManageChannels,
  category: "Settings",
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
    let channel = await client.music.get(`${message.guild.id}.music.channel`);
    let oldChannel = message.guild.channels.cache.get(channel);
    if (oldChannel) {
      return client.embed(
        message,
        `** ${client.config.emoji.ERROR} El panel de música ya está configurado en ${oldChannel}. Elimínalo antes de configurarlo de nuevo. **`
      );
    } else {
      message.guild.channels
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
            .send({ embeds: [client.queueembed(message.guild)] })
            .then(async (queuemsg) => {
              await ch
                .send({
                  embeds: [client.playembed(message.guild)],
                  components: client.buttons(true),
                })
                .then(async (playmsg) => {
                  await client.music.set(`${message.guild.id}.music`, {
                    channel: ch.id,
                    pmsg: playmsg.id,
                    qmsg: queuemsg.id,
                  });
                  client.embed(
                    message,
                    `${client.config.emoji.SUCCESS} Panel de música configurado correctamente en ${ch}`
                  );
                });
            });
        });
    }
  },
};
