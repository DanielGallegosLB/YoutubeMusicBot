const { Message, PermissionFlagsBits } = require("discord.js");
const UserHistory = require("../../../handlers/UserHistory");

module.exports = {
  name: "listasguardadas",
  aliases: ["savedlists", "plpreview", "mislistaspreview"],
  description: `Muestra tus listas guardadas y favoritos`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,
  run: async (client, message) => {
    const embed = await UserHistory.buildPreviewEmbed(client, message.guildId, message.author.id);
    if (!embed) return client.embed(message, `${client.config.emoji.ERROR} No tienes listas guardadas aún.`);
    const components = await UserHistory.buildPreviewComponents(client, message.guildId, message.author.id);
    return message.reply({ embeds: [embed], components }).catch(() => {});
  },
};
