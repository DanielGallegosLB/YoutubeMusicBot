const { Message, PermissionFlagsBits } = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "borrarlista",
  aliases: ["pldelete", "pldel"],
  description: `Borra una lista de reproducción personalizada`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  run: async (client, message, args) => {
    const name = args.join(" ").trim();
    if (!name) return client.embed(message, `${client.config.emoji.ERROR} Provide a playlist name.`);
    const ok = await Store.delete(client, message.guild.id, message.author.id, name);
    if (!ok) return client.embed(message, `${client.config.emoji.ERROR} Playlist not found.`);
    return client.embed(message, `${client.config.emoji.SUCCESS} Deleted \`${name}\`.`);
  },
};
