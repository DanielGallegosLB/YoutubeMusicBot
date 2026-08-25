const { EmbedBuilder, Events, ActivityType } = require("discord.js");
const JUGNU = require("./Client");
const AutoresumeHandler = require("./AutoresumeHandler");
const InitAutoResume = require("./InitAutoresume");
const UserHistory = require("./UserHistory");
const MusicTracker = require("./MusicTracker");

const MAX_SESSION_SONGS = 150;

const activityIntervals = new Map();

function startMarqueeActivity(client, text, guild) {
  stopMarqueeActivity(client, guild);

  const paddedText = `          ♪ ${text} ♪          `;
  let pos = 0;

  const update = () => {
    const rotated = paddedText.slice(pos) + paddedText.slice(0, pos);
    client.user.setActivity(rotated, { type: ActivityType.Playing });
    pos = (pos + 1) % paddedText.length;
  };

  update();
  const interval = setInterval(update, 4000);
  activityIntervals.set(client.user.id, interval);

  if (guild) {
    guild.members.me.setNickname(`♪ ${text}`.substring(0, 32)).catch(() => {});
  }
}

function stopMarqueeActivity(client, guild) {
  const interval = activityIntervals.get(client.user.id);
  if (interval) {
    clearInterval(interval);
    activityIntervals.delete(client.user.id);
  }
  client.user.setActivity(null);
  if (guild) {
    guild.members.me.setNickname(null).catch(() => {});
  }
}

const isOtherRequester = (user, ownerId) => !!(ownerId && user?.id && user.id !== ownerId);

// Índice donde insertar las canciones de otros usuarios: justo después de la
// canción actual y después de las peticiones ya en cola (orden de llegada).
function getRequestsInsertIndex(queue, ownerId) {
  let idx = 1;
  while (idx < queue.songs.length) {
    const s = queue.songs[idx];
    if (!isOtherRequester(s.user, ownerId)) break;
    idx++;
  }
  return idx;
}

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
    MusicTracker.connect();
    setTimeout(
      async () => await AutoresumeHandler(client),
      Math.max(client.ws.ping * 2, 1000)
    );
  });

  // events
  client.distube.on("playSong", async (queue, song) => {
    console.log(`[DisTube] Playing: ${song.name} in ${queue.textChannel.guild.name}`);

    MusicTracker.logPlay(queue.textChannel.guildId, song.user.id, song);

    const activityText = song.uploader?.name
      ? `${song.name} - ${song.uploader.name}`
      : song.name;
    startMarqueeActivity(client, activityText, queue.textChannel.guild);

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

    // Peticiones de otras personas al inicio de la cola (orden de llegada)
    const ownerId = process.env.OWNER_ID;
    if (isOtherRequester(song.user, ownerId) && queue.songs.length > 1) {
      try {
        const currentIndex = queue.songs.findIndex((s) => s === song);
        const insertIndex = getRequestsInsertIndex(queue, ownerId);
        if (currentIndex > insertIndex) {
          queue.songs.splice(currentIndex, 1);
          queue.songs.splice(insertIndex, 0, song);
          client.logger.log(`[Queue Priority] "${song.name}" movida al puesto ${insertIndex + 1}`);
        }
      } catch (e) {
        client.logger.error(`[Queue Priority] Error reordenando:`, e);
      }
    }

    // Update persistent request channel if it exists
    await client.updatequeue(queue);
    await client.updateplayer(queue);

    // Auto-save individual songs to user's favorites (skip if part of a playlist load)
    if (!queue._sessionSourcePlaylist && song.user?.id) {
      try {
        await UserHistory.recordSongPlay(client, queue.textChannel.guildId, song.user.id, song, song.user, queue.textChannel.id);
      } catch (e) {
        client.logger.error(`[UserHistory] Error saving song to favorites:`, e);
      }
    }

    let data = await client.music.get(`${queue.textChannel.guildId}.music`);
    if (data && data.channel === queue.textChannel.id) return;

  });

  client.distube.on("addList", async (queue, playlist) => {
    console.log(`[DisTube] Playlist Added: ${playlist.name} (${playlist.songs.length} songs)`);

    // Playlists de otras personas al inicio de la cola (orden de llegada)
    const ownerId = process.env.OWNER_ID;
    if (
      isOtherRequester(playlist.user, ownerId) &&
      playlist.songs.length > 0 &&
      queue.songs.length > playlist.songs.length
    ) {
      try {
        const n = playlist.songs.length;
        const block = queue.songs.splice(queue.songs.length - n, n);
        const insertIndex = getRequestsInsertIndex(queue, ownerId);
        queue.songs.splice(insertIndex, 0, ...block);
        client.logger.log(`[Queue Priority] Playlist "${playlist.name}" movida al puesto ${insertIndex + 1}`);
      } catch (e) {
        client.logger.error(`[Queue Priority] Error reordenando playlist:`, e);
      }
    }

    // Update persistent request channel if it exists
    await client.updatequeue(queue);
    await client.updateplayer(queue);

    if (!queue._sessionSaved) {
      const session = createSession(queue, "playlist", playlist.name, playlist.url, playlist.user, playlist.songs);
      await saveSession(client, queue.textChannel.guildId, session);
      queue._sessionSaved = true;
    }

    // Record playlist in user's history
    if (playlist.user?.id && playlist.url) {
      try {
        await UserHistory.recordPlaylistPlay(
          client, queue.textChannel.guildId, playlist.user.id, playlist.url, playlist.name, queue.textChannel.id, playlist.thumbnail
        );
      } catch (e) {
        client.logger.error(`[UserHistory] Error recording playlist:`, e);
      }
    }

    let data = await client.music.get(`${queue.textChannel.guildId}.music`);
    if (data && data.channel === queue.textChannel.id) return;

  });

  client.distube.on("disconnect", async (queue) => {
    try {
      const guildId = queue.textChannel.guildId;
      stopMarqueeActivity(client, queue.textChannel.guild);

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
      client.logger.error(`[Disconnect Error]`, error);
    }
  });

  client.distube.on("error", async (error, queue, song) => {
    client.logger.error(`[DisTube Error]`, error);
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
    stopMarqueeActivity(client, queue.textChannel.guild);
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
