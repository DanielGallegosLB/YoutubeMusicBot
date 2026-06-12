const { EmbedBuilder, Events } = require("discord.js");
const JUGNU = require("./Client");
const AutoresumeHandler = require("./AutoresumeHandler");
const InitAutoResume = require("./InitAutoResume");

const MAX_SESSION_SONGS = 150;

const buildSessionTrack = (song) => ({
  memberId: song.member?.id || song.user?.id || null,
  source: song.source || "youtube",
  duration: song.duration,
  formattedDuration: song.formattedDuration,
  id: song.id,
  isLive: song.isLive,
  name: song.name,
  thumbnail: song.thumbnail,
  type: "video",
  uploader: song.uploader,
  url: song.url,
  views: song.views,
});

const saveSession = async (client, guildId, session) => {
  if (!client.music) return;
  const key = `${guildId}.sessions`;
  const sessions = (await client.music.get(key)) || [];
  sessions.unshift(session);
  await client.music.set(key, sessions.slice(0, 10));
};

const createSession = (queue, source, title, url, requestedBy, songs) => {
  const normalizedSongs = (songs || queue.songs || []).slice(0, MAX_SESSION_SONGS).map(buildSessionTrack);
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    source,
    title: title || queue?.songs?.[0]?.name || "Sesión de música",
    url: url || queue?.songs?.[0]?.url || null,
    requestedBy: requestedBy?.tag || requestedBy || "Desconocido",
    requestedById: requestedBy?.id || null,
    count: normalizedSongs.length,
    totalDuration: queue?.duration || normalizedSongs.reduce((sum, track) => sum + (track.duration || 0), 0),
    truncated: (songs || queue.songs || []).length > MAX_SESSION_SONGS,
    songs: normalizedSongs,
  };
};

/**
 *
 * @param {JUGNU} client
 */
module.exports = async (client) => {
  client.saveMusicSession = async (guildId, session) => saveSession(client, guildId, session);
  client.createMusicSession = createSession;

  client.on(Events.ClientReady, async () => {
    setTimeout(
      async () => await AutoresumeHandler(client),
      Math.max(client.ws.ping * 2, 1000)
    );
  });

  // events
  client.distube.on("playSong", async (queue, song) => {
    console.log(`[DisTube] Playing: ${song.name} in ${queue.textChannel.guild.name}`);
    
    // Update persistent request channel if it exists
    await client.updatequeue(queue);
    await client.updateplayer(queue);

    if (!queue._sessionSaved && queue.songs.length === 1 && !queue._sessionSourcePlaylist) {
      const session = createSession(queue, "song", song.name, song.url, song.user, [song]);
      await saveSession(client, queue.textChannel.guildId, session);
      queue._sessionSaved = true;
    }

    let data = await client.music.get(`${queue.textChannel.guildId}.music`);
    if (data && data.channel === queue.textChannel.id) return;

    queue.textChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setDescription(`** [\`${client.getTitle(song)}\`](${song.url}) **`)
            .addFields([
              {
                name: `Requested By`,
                value: `\`${song.user.tag}\``,
                inline: true,
              },
              {
                name: `Author`,
                value: `\`${song.uploader.name}\``,
                inline: true,
              },
              {
                name: `Duration`,
                value: `\`${song.formattedDuration}\``,
                inline: true,
              },
            ])
            .setFooter(client.getFooter(song.user)),
        ],
        components: client.buttons(false, queue),
      })
      .then((msg) => {
        client.temp.set(queue.textChannel.guildId, msg.id);
      });
  });

  client.distube.on("addSong", async (queue, song) => {
    console.log(`[DisTube] Song Added: ${song.name}`);
    
    // Update persistent request channel if it exists
    await client.updatequeue(queue);
    await client.updateplayer(queue);

    let data = await client.music.get(`${queue.textChannel.guildId}.music`);
    if (data && data.channel === queue.textChannel.id) return;

    queue.textChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setAuthor({
              name: `Added to Queue`,
              iconURL: song.user.displayAvatarURL({ dynamic: true }),
              url: song.url,
            })
            .setThumbnail(song.thumbnail)
            .setDescription(`[\`${client.getTitle(song)}\`](${song.url})`)
            .addFields([
              {
                name: `Requested By`,
                value: `\`${song.user.tag}\``,
                inline: true,
              },
              {
                name: `Author`,
                value: `\`${song.uploader.name}\``,
                inline: true,
              },
              {
                name: `Duration`,
                value: `\`${song.formattedDuration}\``,
                inline: true,
              },
            ])
            .setFooter(client.getFooter(song.user)),
        ],
      })
      .then((msg) => {
        setTimeout(() => {
          msg.delete().catch((e) => null);
        }, 5000);
      });
  });

  client.distube.on("addList", async (queue, playlist) => {
    console.log(`[DisTube] Playlist Added: ${playlist.name} (${playlist.songs.length} songs)`);
    
    // Update persistent request channel if it exists
    await client.updatequeue(queue);
    await client.updateplayer(queue);

    if (!queue._sessionSaved) {
      const session = createSession(queue, "playlist", playlist.name, playlist.url, playlist.user, playlist.songs);
      await saveSession(client, queue.textChannel.guildId, session);
      queue._sessionSaved = true;
    }

    let data = await client.music.get(`${queue.textChannel.guildId}.music`);
    if (data && data.channel === queue.textChannel.id) return;

    queue.textChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setAuthor({
              name: `Playlist Added to Queue`,
              iconURL: playlist.user.displayAvatarURL({ dynamic: true }),
              url: playlist.url,
            })
            .setThumbnail(playlist.thumbnail)
            .setDescription(`** [\`${playlist.name}\`](${playlist.url}) **`)
            .addFields([
              {
                name: `Requested By`,
                value: `\`${playlist.user.tag}\``,
                inline: true,
              },
              {
                name: `Songs`,
                value: `\`${playlist.songs.length}\``,
                inline: true,
              },
              {
                name: `Duration`,
                value: `\`${playlist.formattedDuration}\``,
                inline: true,
              },
            ])
            .setFooter(client.getFooter(playlist.user)),
        ],
      })
      .then((msg) => {
        setTimeout(() => {
          msg.delete().catch((e) => null);
        }, 5000);
      });
  });

  client.distube.on("disconnect", async (queue) => {
    try {
      const guildId = queue.textChannel.guildId;

      // Remove auto-resume entry
      await client.autoresume.delete(guildId);

      // Edit player message
      await client.editPlayerMessage(queue.textChannel);

      // Update embed
      await client.updateembed(client, queue.textChannel.guild);

      // Check if auto-joining is enabled in the database
      const db = await client.music?.get(`${guildId}.vc`);
      const data = await client.music.get(`${guildId}.music`);

      if (!db?.enable && data && data.channel !== queue.textChannel.id) {
        // If auto-joining is disabled and the current queue channel does not match the disconnected channel
        const embed = new EmbedBuilder()
          .setColor(client.config.embed.color)
          .setDescription(
            `> The bot has been disconnected from the voice channel.`
          );

        const msg = await queue.textChannel.send({ embeds: [embed] });
        setTimeout(() => msg.delete().catch(() => {}), 3000);
      } else if (db?.enable) {
        // If auto-joining is enabled, rejoin the voice channel
        await client.joinVoiceChannel(queue.textChannel.guild);
      }
    } catch (error) {
      console.error("An error occurred in disconnect event:", error);
    }
  });

  client.distube.on("error", async (error, queue, song) => {
    console.error("[DisTube Error]", error);
    queue.textChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setTitle(`Found a Error...`)
            .setDescription(String(error).substring(0, 3000)),
        ],
      })
      .then((msg) => {
        setTimeout(() => {
          msg.delete().catch((e) => null);
        }, 5000);
      });
  });

  client.distube.on("noRelated", async (queue) => {
    queue.textChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setTitle(`No Related Song Found for \`${queue?.songs[0].name}\``),
        ],
      })
      .then((msg) => {
        setTimeout(() => {
          msg.delete().catch((e) => null);
        }, 5000);
      });
  });

  client.distube.on("finishSong", async (queue, song) => {
    await client.editPlayerMessage(queue.textChannel);
    await client.updatequeue(queue);
    await client.updateplayer(queue);
  });

  client.distube.on("finish", async (queue) => {
    await client.updateembed(client, queue.textChannel.guild);
    await client.editPlayerMessage(queue.textChannel);
    // Remove auto-resume entry
    await client.autoresume.delete(queue.textChannel.guild.id);

    // Leave voice channel if 24/7 is disabled
    try {
      const db = await client.music?.get(`${queue.textChannel.guild.id}.vc`);
      if (!db?.enable) {
        await client.distube.voices.leave(queue.textChannel.guild);
      }
    } catch (e) {
      // ignore leave errors
    }

    queue.textChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setDescription(`Queue has ended! No more music to play`),
        ],
      })
      .then((msg) => {
        setTimeout(() => {
          msg.delete().catch((e) => null);
        }, 5000);
      });
  });

  client.distube.on("initQueue", async (queue) => {
    queue.volume = client.config.options.defaultVolume;

    // init auto resume for the queue
    await InitAutoResume(client, queue);
  });

  client.distube.on("searchCancel", async (message, quary) => {
    message.channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setDescription(`I cant search \`${quary}\``),
        ],
      })
      .then((msg) => {
        setTimeout(() => {
          msg.delete().catch((e) => null);
        }, 5000);
      });
  });

  client.distube.on("searchNoResult", async (message, quary) => {
    message.channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setDescription(
              `${client.config.emoji.ERROR} No result found for \`${quary}\`!`
            ),
        ],
      })
      .then((msg) => {
        setTimeout(() => {
          msg.delete().catch((e) => null);
        }, 5000);
      });
  });
};
