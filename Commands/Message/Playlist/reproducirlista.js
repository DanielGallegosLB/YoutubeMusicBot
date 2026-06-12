const { Message, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
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
    const statusMsg = await client.embed(message, `⏳ Cargando lista \`${pl.name}\`... (0/${pl.tracks.length})`);

    let addedCount = 0;
    try {
      await client.distube.play(vc, pl.tracks[0].url || pl.tracks[0].name, {
        member: message.member,
        textChannel: message.channel,
        message,
      });
      addedCount++;
    } catch (e) {
      client.logger.error("Error al cargar primer track:", e);
    }

    client.playlistLoading.set(message.guild.id, true);
    const tracks = pl.tracks.slice(1);
    for (let i = 0; i < tracks.length; i++) {
      if (!client.playlistLoading.get(message.guild.id)) break;
      const t = tracks[i];
      try {
        await client.distube.play(vc, t.url || t.name, {
          member: message.member,
          textChannel: message.channel,
          message,
        });
        addedCount++;
      } catch (e) {
        client.logger.error("Error al cargar track de lista:", e);
      }
      
      // Actualizar progreso cada 5 canciones o al final
      if (addedCount % 5 === 0 || i === tracks.length - 1) {
        if (statusMsg && statusMsg.edit) {
          statusMsg.edit({
            embeds: [
              new EmbedBuilder()
                .setColor(client.config.embed.color)
                .setDescription(`⏳ Cargando lista \`${pl.name}\`... (${addedCount}/${pl.tracks.length} canciones añadidas)`)
                .setFooter(client.getFooter(message.author)),
            ],
          }).catch(() => {});
        }
      }
      // Tiempo de espera para procesar interacciones
      await new Promise((r) => setTimeout(r, 250));
    }

    if (statusMsg && statusMsg.edit) {
      statusMsg.edit({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setDescription(`✅ Lista cargada: \`${pl.name}\` (${addedCount} canciones añadidas).`)
            .setFooter(client.getFooter(message.author)),
        ],
      }).catch(() => {});
    }
    client.playlistLoading.delete(message.guild.id);

    return;
  },
};
