const { Message, PermissionFlagsBits } = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "guardarcancionenlista",
  aliases: ["plsavenowplaying", "plsavenc", "plsavenp", "addtoplaylist"],
  description: `Guarda la canción actual en una lista`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Playlist",
  cooldown: 3,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,
  run: async (client, message, args) => {
    const name = args.join(" ").trim();
    if (!name) return client.embed(message, `${client.config.emoji.ERROR} Provide a playlist name.`);
    const q = client.distube.getQueue(message.guild.id);
    if (!q || !q.songs?.length) return client.embed(message, `${client.config.emoji.ERROR} Nothing is playing.`);
    const track = Store.serializeSong(q.songs[0], message.author);
    await Store.create(client, message.guild.id, message.author.id, name);
    await Store.addTracks(client, message.guild.id, message.author.id, name, [track]);
    return client.embed(message, `${client.config.emoji.SUCCESS} Saved current song to \`${name}\`.`);
  },
};
