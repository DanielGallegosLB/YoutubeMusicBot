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
  options: [
    {
      name: "canal",
      description: "Canal de texto existente donde deseas colocar el panel de música",
      type: 7, // Channel type
      required: false,
      channelTypes: [ChannelType.GuildText],
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
    // Obtener el canal especificado por opción (si el usuario lo pasó)
    const targetChannel = interaction.options.getChannel("canal");

    let musicData = await client.music.get(`${interaction.guild.id}.music`);
    let channelId = musicData?.channel || musicData; // por si se guardó solo como string en versiones previas
    let oldChannel = interaction.guild.channels.cache.get(typeof channelId === 'object' ? channelId.channel : channelId);

    // Si el canal antiguo ya no existe en el servidor, limpiamos la base de datos automáticamente
    if (musicData && !oldChannel) {
      await client.music.delete(`${interaction.guild.id}.music`);
      oldChannel = null;
    }

    // Función auxiliar para configurar el embed y mensajes en el canal seleccionado
    const setupPanelInChannel = async (ch) => {
      // Intentar borrar mensajes viejos de qmsg/pmsg si existían en el registro anterior
      if (typeof musicData === 'object' && musicData !== null) {
        try {
          if (musicData.qmsg) {
            const qMsgOld = await ch.messages.fetch(musicData.qmsg).catch(() => null);
            if (qMsgOld) await qMsgOld.delete().catch(() => {});
          }
          if (musicData.pmsg) {
            const pMsgOld = await ch.messages.fetch(musicData.pmsg).catch(() => null);
            if (pMsgOld) await pMsgOld.delete().catch(() => {});
          }
        } catch (e) {}
      }

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
              return client.embed(
                interaction,
                `${client.config.emoji.SUCCESS} Panel de música configurado correctamente en ${ch}`
              );
            });
        });
    };

    // Si ya existe un canal configurado y válido
    if (oldChannel && !targetChannel) {
      return client.embed(
        interaction,
        `** ${client.config.emoji.ERROR} El panel de música ya está configurado en ${oldChannel}. Elimínalo o usa el comando especificando un nuevo canal para moverlo. **`
      );
    }

    // CASO A: El usuario especificó un canal existente para moverlo/reconfigurarlo ahí
    if (targetChannel) {
      await setupPanelInChannel(targetChannel);
      return;
    }

    // CASO B: No existe canal configurado, creamos uno nuevo automáticamente
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
        await setupPanelInChannel(ch);
      });
  },
};