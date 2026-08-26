const { Message, PermissionFlagsBits } = require("discord.js");
const UserHistory = require("../../../handlers/UserHistory");

module.exports = {
  name: "misfavoritos",
  aliases: ["myfav", "myfavorites", "favs"],
  description: `Gestiona tus canciones favoritas`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,
  run: async (client, message) => {
    const embed = await UserHistory.buildFavoritesEmbed(client, message.guildId, message.author.id, 0);
    if (!embed) return client.embed(message, `${client.config.emoji.ERROR} No tienes canciones favoritas aún.`);
    const components = await UserHistory.buildFavoritesComponents(client, message.guildId, message.author.id, 0);
    const msg = await message.reply({ embeds: [embed], components }).catch(() => null);
    if (msg) {
      if (!client.favPages) client.favPages = new Map();
      client.favPages.set(msg.id, 0);
    }
  },
};
