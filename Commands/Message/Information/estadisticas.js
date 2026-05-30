const {
  Message,
  EmbedBuilder,
  version,
  PermissionFlagsBits,
} = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");
const { msToDuration, formatBytes } = require("../../../handlers/functions");
const os = require("systeminformation");

module.exports = {
  name: "estadisticas",
  aliases: ["botinfo","stats"],
  description: `Ver las estadísticas del bot`,
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
   * @param {JUGNU} client
   * @param {Message} message
   * @param {String[]} args
   * @param {String} prefix
   * @param {Queue} queue
   */
  run: async (client, message, args, prefix, queue) => {
    // Code
    let memory = await os.mem();
    let cpu = await os.cpu();
    let cpuUsage = await (await os.currentLoad()).currentLoad;
    let osInfo = await os.osInfo();
    let TotalRam = formatBytes(memory.total);
    let UsageRam = formatBytes(memory.used);

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(client.config.embed.color)
          .setTitle("__**Estadísticas:**__")
          .setThumbnail(client.user.displayAvatarURL())
          .setDescription(
            `> **`
          )
          .addFields([
            {
              name: `⏳ Uso de Memoria`,
              value: `\`${UsageRam}\` / \`${TotalRam}\``,
            },
            {
              name: `⌚️ Tiempo Activo`,
              // value: `<t:${Math.floor(
              //   Date.now() / 1000 - client.uptime / 1000
              // )}:R>`,
              value: `\`${msToDuration(client.uptime)}\``,
            },
            {
              name: `📁 Usuarios`,
              value: `\`${client.guilds.cache.size} \``,
              inline: true,
            },
            {
              name: `📁 Servidores`,
              value: `\`${client.guilds.cache.size}\``,
              inline: true,
            },
            {
              name: `📁 Canales`,
              value: `\`${client.channels.cache.size}\``,
              inline: true,
            },
            {
              name: `👾 Discord.JS`,
              value: `\`v${version}\``,
              inline: true,
            },
            {
              name: `🤖 Node`,
              value: `\`${process.version}\``,
              inline: true,
            },
            {
              name: `🏓 Ping`,
              value: `\`${client.ws.ping}ms\``,
              inline: true,
            },
            {
              name: `🤖 Uso de CPU`,
              value: `\`${Math.floor(cpuUsage)}%\``,
              inline: true,
            },
            {
              name: `🤖 Arquitectura`,
              value: `\`${osInfo.arch}\``,
              inline: true,
            },
            {
              name: `💻 Plataforma`,
              value: `\`\`${osInfo.platform}\`\``,
              inline: true,
            },
            {
              name: `🤖 CPU`,
              value: `\`\`\`fix\n${cpu.brand}\`\`\``,
            },
          ])
          .setFooter(client.getFooter(message.author)),
      ],
    });
  },
};
