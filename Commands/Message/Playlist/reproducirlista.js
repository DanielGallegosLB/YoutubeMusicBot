const { Message, PermissionFlagsBits } = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "reproducirlista",
  aliases: ["plplay", "playplaylist"],
  description: `Reproduce una de tus listas de reproducción`,
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
    const pl = await Store.get(client, message.guild.id, message.author.id, name);
    if (!pl || !pl.tracks.length) return client.embed(message, `${client.config.emoji.ERROR} Playlist is empty or not found.`);
    const vc = message.member.voice.channel;
    if (!vc) return client.embed(message, `${client.config.emoji.ERROR} Join a voice channel first.`);
    if (message.guild.members.me.voice.channel && !message.guild.members.me.voice.channel.equals(vc))
      return client.embed(message, `${client.config.emoji.ERROR} You need to join my voice channel.`);
    const first = pl.tracks[0];
    await client.distube.play(vc, first.url || first.name, {
      member: message.member,
      textChannel: message.channel,
      message,
    });

    client.playlistLoading.set(message.guild.id, true);
    for (const t of pl.tracks.slice(1)) {
      if (!client.playlistLoading.get(message.guild.id)) break;
      await client.distube.play(vc, t.url || t.name, {
        member: message.member,
        textChannel: message.channel,
        message,
      });
      // Tiempo de espera para procesar interacciones
      await new Promise((r) => setTimeout(r, 250));
    }
    client.playlistLoading.delete(message.guild.id);

    return client.embed(message, `${client.config.emoji.SUCCESS} Reproduciendo lista \`${pl.name}\` (${pl.tracks.length} pistas).`);
  },
};
