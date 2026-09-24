const { EmbedBuilder, Events } = require("discord.js");
const MusicBot = require("./Client");
const AutoresumeHandler = require("./AutoresumeHandler");
const InitAutoResume = require("./InitAutoresume");
const UserHistory = require("./UserHistory");
const MusicTracker = require("./MusicTracker");
const PlaylistStore = require("./PlaylistStore");
const { isAgeGateError, friendlyPlaybackError } = require("./PlaybackError");
const { startMarqueeActivity, stopMarqueeActivity } = require("./ActivityManager");

const MAX_SESSION_SONGS = 150;

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
 * @param {MusicBot} client
 */
module.exports = async (client) => {
  client.saveMusicSession = async (guildId, session) => saveSession(client, guildId, session);
  client.createMusicSession = createSession;

  /**
   * Auto DJ constante: mezcla la cola mientras el DJ esté activo.
   *
   * Fase 1 (rápida, sin red): REORDENA las canciones que ya están en cola
   * subiendo las que coinciden con favoritas de quien escucha (interleave por
   * score = el "algoritmo del bot") e intercalándolas con el resto, para que
   * se escuche más seguido lo que más gusta.
   *
   * Fase 2 (si el algoritmo lo determina y la cola va corta): AÑADE 1 canción
   * elegida por el algoritmo + 2-3 aleatorias, SIN límite de 20 y SIN repetir
   * lo que ya se reprodujo/encoló en la sesión (_autoDjSeen). Las recién
   * añadidas se suben del final y se mezclan con lo que quedaba.
   *
   * @param {object} queue - cola de DisTube
   * @param {object} [opts]
   * @param {object} [opts.channel] - canal de voz (seed inicial)
   * @param {boolean} [opts.force]  - fuerza el reabastecimiento aunque queden canciones
   * @returns {Promise<number>} - cantidad de canciones añadidas
   */
  client.autoDjRefill = async (queue, { channel, force = false } = {}) => {
    const guildId = queue.textChannel?.guildId || queue.guildId;
    if (!guildId || !client.autoDj?.get(guildId) || !queue?.songs?.length) return 0;

    const vc = channel || queue.voice?.connection?.channel || queue.textChannel?.guild?.members?.me?.voice?.channel;
    if (!vc || !vc.members) return 0;
    const listeners = vc.members.filter((m) => !m.user.bot).map((m) => m.id);
    if (!listeners.length) return 0;

    // Historial de la sesión para no repetir canciones.
    if (!queue._autoDjSeen) queue._autoDjSeen = new Set();
    const seen = queue._autoDjSeen;

    // Pool = favoritas intercaladas de TODA la gente que escucha, ordenadas
    // por score (el algoritmo del bot).
    const favs = await PlaylistStore.getInterleavedFavorites(client, guildId, listeners);
    if (!favs.length) return 0;

    const shuffleAny = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

    // ---- Fase 1: reordenar la cola existente (1 "seleccionada" : 3 aleatorias) ----
    // "Seleccionada" = favorita que el algoritmo elige (lleva badge 🛸). El resto
    // de la cola (favoritas o no, es decir canciones de la lista) = aleatorias.
    // Así el AutoDJ SIEMPRE intercala y el badge solo sale en lo que realmente eligió.
    const favUrls = new Set();
    for (const f of favs) if (f?.url) favUrls.add(f.url);

    const current = queue.songs[0];
    const rest = queue.songs.slice(1).filter(Boolean);
    const favsInQueue = rest.filter((s) => s?.url && favUrls.has(s.url));

    if (favsInQueue.length && rest.length > 1) {
      // Rota las elegidas para no repetir: primero las favoritas que aún no se
      // han seleccionado esta sesión; si todas ya se usaron, rota de nuevo.
      if (!queue._autoDjSelected) queue._autoDjSelected = new Set();
      const selectedUrls = queue._autoDjSelected;
      const orderUrl = favs.map((f) => f.url);
      const byScore = (a, b) => orderUrl.indexOf(a.url) - orderUrl.indexOf(b.url);
      let candidates = favsInQueue.filter((s) => !selectedUrls.has(s.url)).sort(byScore);
      if (!candidates.length) { selectedUrls.clear(); candidates = favsInQueue.slice().sort(byScore); }
      // ≈1 cada 4 canciones llevan badge (patrón 1 seleccionada : 3 aleatorias).
      const selCount = Math.max(1, Math.floor(rest.length / 4));
      const selections = candidates.slice(0, selCount);
      for (const s of selections) selectedUrls.add(s.url);

      // El resto de la cola se baraja como "aleatorias de la lista" (sin badge).
      const usedSele = new Set(selections.map((s) => s.url));
      const otherSongs = rest.filter((s) => !usedSele.has(s.url));
      const restShuffled = shuffleAny(otherSongs);

      const mixed = [];
      let si = 0;
      let oi = 0;
      while (si < selections.length || oi < restShuffled.length) {
        if (si < selections.length) mixed.push(selections[si++]);
        const filler = 3; // patrón 1 seleccionada : 3 aleatorias
        for (let f = 0; f < filler && oi < restShuffled.length; f++) mixed.push(restShuffled[oi++]);
      }

      // Limpiar badge previo (incluida la canción actual) y marcar SOLO las
      // seleccionadas. La actual conserva el badge solo si era una seleccionada.
      for (const s of [current, ...rest]) { s.autoDj = false; s._autoDj = false; }
      for (const s of selections) { s.autoDj = true; s._autoDj = true; }

      const finalSeen = new Set();
      const finalQueue = [];
      for (const s of [current, ...mixed]) {
        if (s?.url && finalSeen.has(s.url)) continue;
        if (s?.url) finalSeen.add(s.url);
        finalQueue.push(s);
      }
      queue.songs = finalQueue;
      client.logger.log(
        `[AutoDJ] Fase1 reorden: ${selections.length} seleccionada(s) con badge / ${restShuffled.length} aleatorias (len ${queue.songs.length})`
      );
      for (const s of queue.songs) if (s?.url) seen.add(s.url);
      try { client.updatequeue(queue).catch(() => {}); } catch (e) {}
    }

    // ---- Fase 2: añadir SOLO si el algoritmo lo decide y la cola va corta ----
    const upNext = queue.songs.length - 1;
    if (!force && upNext >= 4) return 0;

    const algoPick = favs.find((f) => f.url && !seen.has(f.url));
    if (!algoPick) return 0;
    seen.add(algoPick.url);

    // "3 aleatorias": canciones que le gustan al oyente (sus favoritas, que incluyen
    // lo de la lista reproducida porque addSong lo va guardando). Filtra lo ya
    // usado/encolado y el algoPick para no repetir.
    const randPool = favs.filter((f) => f.url && f !== algoPick && !seen.has(f.url));
    const randomCount = 3; // patrón pedido: 1 algorítmica + 3 aleatorias
    const randoms = shuffleAny(randPool).slice(0, randomCount);
    for (const f of randoms) if (f?.url) seen.add(f.url);

    const block = [algoPick, ...randoms].filter(Boolean);
    if (!block.length) return 0;

    // Materializar como Song objects reales (DisTube necesita la resolución).
    // member SIEMPRE debe ser un GuildMember real: si songs[0] no trae member
    // (p.ej. añadido por AutoDJ sin requester), usamos el bot como fallback
    // para que las canciones nuevas tengan user/member y no rompan embed/autoresume.
    const playOpts = { member: queue.songs[0]?.member || vc?.guild?.members?.me, textChannel: queue.textChannel, selfDeaf: true, skip: false };
    const addedUrls = [];
    for (const f of block) {
      try {
        await client.distube.play(vc, f.url, playOpts);
        addedUrls.push(f.url);
      } catch (e) {
        client.logger.error(`[AutoDJ] No se pudo añadir favorita ${f.url}:`, e?.message || e);
      }
    }
    if (!addedUrls.length) return 0;

    // Subir las recién añadidas del final e intercalarlas con lo que quedaba.
    // Badge SOLO en la algorítmica (algoPick); las 3 aleatorias NO se marcan.
    const q = client.distube.getQueue(guildId) || queue;
    const addedSet = new Set(addedUrls);
    let alreadyPicked = false;
    const newBlock = [];
    const restAll = [];
    for (let i = 1; i < q.songs.length; i++) {
      const s = q.songs[i];
      if (s?.url && addedSet.has(s.url) && !newBlock.includes(s)) {
        // La primera recién añadida que aparece en la cola es el algoPick (badge),
        // el resto son las aleatorias (sin badge).
        if (!alreadyPicked) { s.autoDj = true; s._autoDj = true; alreadyPicked = true; }
        else { s.autoDj = false; s._autoDj = false; }
        newBlock.push(s);
      }
      else if (s) restAll.push(s);
    }
    const restShuffled = shuffleAny(restAll);
    const mixed = [];
    let ni = 0;
    let ri = 0;
    while (ni < newBlock.length || ri < restShuffled.length) {
      if (ni < newBlock.length) mixed.push(newBlock[ni++]);
      const filler = 3; // patrón 1:3 en el bloque intercalado
      for (let f = 0; f < filler && ri < restShuffled.length; f++) mixed.push(restShuffled[ri++]);
    }
    const finalSeen = new Set();
    const finalQueue = [];
    for (const s of [q.songs[0], ...mixed]) {
      if (!s?.url || !finalSeen.has(s.url)) { if (s?.url) finalSeen.add(s.url); finalQueue.push(s); }
    }
    q.songs = finalQueue;
    client.logger.log(
      `[AutoDJ] Fase2: songs[0] "${q.songs[0]?.name}" queda primero tras mezclar ${newBlock.length} nuevas + ${restShuffled.length} restantes`
    );
    for (const s of q.songs) if (s?.url) seen.add(s.url);
    try { client.updatequeue(q).catch(() => {}); } catch (e) {}
    try { client.updateplayer(q).catch(() => {}); } catch (e) {}
    return addedUrls.length;
  };

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

    // Qué está SONANDO de verdad (lo emite DisTube en el voice). Se usa para
    // detectar desfases con queue.songs[0] (que el autodj / reorden tocan a mano).
    if (!client.actualPlaying) client.actualPlaying = new Map();
    const gid = queue.textChannel?.guildId || queue.guildId;
    client.actualPlaying.set(gid, {
      name: song.name,
      url: song.url,
      elapsed: Date.now(),
      autodj: !!song.autoDj,
      requestedBy: song.user?.id || null,
    });

    instrumentVoice(queue);

    queue._playSeq = (queue._playSeq || 0) + 1;

    // DJ constante: a cada canción que empieza, la cola se reabastece sola en
    // el fondo mientras Auto DJ siga activo (1 por algoritmo + 2-3 aleatorias).
    if (client.autoDj?.get(queue.textChannel.guildId)) {
      client.autoDjRefill(queue).catch(() => {});
    }

    MusicTracker.logPlay(queue.textChannel.guildId, song.user.id, song);

    // Count the play only when the song actually starts playing (not when queued)
    if (song.user?.id && song.url) {
      try {
        await PlaylistStore.countPlay(client, queue.textChannel.guildId, song.user.id, "Canciones Favoritas", song.url);
      } catch (e) {
        client.logger.error(`[CountPlay] Error:`, e);
      }
    }

    const activityText = song.uploader?.name
      ? `${song.name} - ${song.uploader.name}`
      : song.name;
    startMarqueeActivity(client, activityText, queue.textChannel.guild);

    if (!queue._sessionSaved && queue.songs.length === 1 && !queue._sessionSourcePlaylist) {
      const session = createSession(queue, "song", song.name, song.url, song.user, [song]);
      await saveSession(client, queue.textChannel.guildId, session);
      queue._sessionSaved = true;
    }

    // Fire-and-forget the request-channel/player updates so they never delay
    // the start of the next song.
    client.updatequeue(queue).catch(() => {});
    client.updateplayer(queue).catch(() => {});

    let data = await client.music.get(`${queue.textChannel.guildId}.music`);
    if (data && data.channel === queue.textChannel.id) return;

    // Delete the previous "now playing" message before sending a fresh one
    const prevId = client.temp.get(queue.textChannel.guildId);
    if (prevId) {
      try {
        const prevMsg = await queue.textChannel.messages.fetch(prevId).catch(() => null);
        if (prevMsg && !prevMsg.deleted) await prevMsg.delete().catch(() => {});
      } catch (e) {}
    }

    let statsValue = null;
    if (song.url) {
      try {
        const stats = await PlaylistStore.getGlobalTrackStats(client, queue.textChannel.guildId, song.url)
          .catch(() => ({ likes: 0, dislikes: 0, plays: 0, likedBy: [], dislikedBy: [] }));
        const statsParts = [];
        if (stats.likes > 0) statsParts.push(`👍${stats.likes}`);
        if (stats.dislikes > 0) statsParts.push(`👎${stats.dislikes}`);
        if (stats.plays > 0) statsParts.push(`🔥${stats.plays}`);
        const likeNames = (stats.likedBy || []).length ? `\n👍 Likes: ${stats.likedBy.join(", ")}` : "";
        const dislikeNames = (stats.dislikedBy || []).length ? `\n👎 Dislikes: ${stats.dislikedBy.join(", ")}` : "";
        statsValue = stats.likes > 0 || stats.dislikes > 0 || stats.plays > 0
          ? `${statsParts.join(" · ")}${likeNames}${dislikeNames}`
          : "Sin stats aún";
      } catch (e) {}
    }

    const playFields = [
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
    ];
    if (statsValue !== null) {
      playFields.push({
        name: `Stats`,
        value: `\`${statsValue}\``,
        inline: true,
      });
    }

    queue.textChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setDescription(`** [\`${client.getTitle(song)}\`](${song.url}) **`)
            .addFields(playFields)
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
    client.updatequeue(queue).catch(() => {});
    client.updateplayer(queue).catch(() => {});

    const _head = queue.songs.slice(0, 3).map((s) => s?.name || "?").join(" | ");
    client.logger.log(`[addSong] "${song.name}" -> head: ${_head} (len ${queue.songs.length})`);

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
    client.updatequeue(queue).catch(() => {});
    client.updateplayer(queue).catch(() => {});

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
      client.editPlayerMessage(queue.textChannel).catch(() => {});

      // Update embed
      client.updateembed(client, queue.textChannel.guild).catch(() => {});

      // Check if this disconnect was caused by an explicit stop command
      const stoppedAt = client.playlistStopped.get(guildId);
      if (stoppedAt) {
        client.playlistStopped.delete(guildId);
        client.logger.log(`[Disconnect] Guild ${guildId}: disconnect after explicit stop, skipping auto-rejoin`);
        return;
      }

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
        client.logger.log(`[Disconnect] Guild ${guildId}: 24/7 activo, reconectando...`);
        await client.joinVoiceChannel(queue.textChannel.guild);
      }
    } catch (error) {
      client.logger.error(`[Disconnect Error]`, error);
    }
  });

  client.distube.on("error", async (error, queue, song) => {
    const code = error?.errorCode || error?.code;
    if (code === "FFMPEG_EXITED") {
      const trackName = song?.name ? `"${song.name}"` : `#${queue?.songs?.[0]?.name || "desconocida"}`;
      client.logger.error(
        `[FFMPEG_EXITED] La reproducción de la canción ${trackName} se interrumpió. ` +
        `Causa probable: el stream de YouTube fue throttled/cortado (cookies faltantes o cliente web_embedded) o el proceso de ffmpeg falló. ` +
        `Saltando a la siguiente canción si existe para continuar la reproducción.`
      );
      // Try to skip to the next song so playback continues instead of dying silently
      if (queue && queue.songs && queue.songs.length > 1) {
        try {
          await queue.skip();
          client.logger.error(`[FFMPEG_EXITED] Saltando "${trackName}" y reproduciendo la siguiente (${queue.songs[0]?.name || "..."})`);
        } catch (e) {
          client.logger.error(`[FFMPEG_EXITED] No se pudo saltar la canción:`, e);
        }
      } else {
        client.logger.error(`[FFMPEG_EXITED] No hay más canciones en la cola, la reproducción se detuvo.`);
      }
      return;
    }

    client.logger.error(`[DisTube Error]`, error);
    if (!queue?.textChannel) return;
    queue.textChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setTitle(`Found a Error...`)
            .setDescription(
              isAgeGateError(error)
                ? friendlyPlaybackError(error)
                : String(error).substring(0, 3000)
            ),
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
    // Fire-and-forget so the next song starts immediately (these do heavy DB/network work)
    client.editPlayerMessage(queue.textChannel).catch(() => {});
    client.updatequeue(queue).catch(() => {});
    client.updateplayer(queue).catch(() => {});

    // NO tocar actualPlaying acá: lo único que confirma qué canción emite es
    // playSong. Si lo "avanzamos" nosotros, el diagnóstico miente.
    // (La canción real la verá la snapshot al cruzar playSong con queue.songs).
  });

  client.distube.on("finish", async (queue) => {
    if (client.actualPlaying) client.actualPlaying.delete(queue.textChannel?.guildId || queue.id);
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

  // ---- Voice / DAVE / player diagnostics (one-time per guild) ----
    const instrumentVoice = (queue) => {
      const guildId = queue.textChannel?.guildId || queue.guildId;
      const voice = queue.voice;
      if (!voice || voice._jvdDiag) return;
      voice._jvdDiag = true;
      const conn = voice.connection;
      if (conn) {
        conn.on("stateChange", (oldState, newState) => {
          client.logger.log(`[VoiceDiag ${guildId}] conn ${oldState.status} -> ${newState.status}`);
        });
        conn.on("debug", (msg) => client.logger.log(`[VoiceDiag ${guildId}] DBG ${String(msg).slice(0, 400)}`));
      }
      if (voice.audioPlayer) {
        voice.audioPlayer.on("stateChange", (oldState, newState) => {
          const status = newState.status;
          if (status === "idle" || status === "playing" || status === "buffering") {
            // La canción que el voice está emitiendo DE VERDAD (del resource
            // real del audioPlayer), para cruzarla con queue.songs[0].
            let resName = null;
            let resMeta = null;
            try {
              const res = newState.resource;
              if (res?.metadata) resMeta = res.metadata;
              if (resName === null && resMeta?.name) resName = resMeta.name;
              if (resMeta?.title && !resName) resName = resMeta.title;
              if (res?.playbackDuration !== undefined) resName = `${resName ?? "?"} (played ${Math.round(res.playbackDuration/1000)}s)`;
            } catch {}
            client.logger.log(
              `[VoiceDiag ${guildId}] player ${oldState.status} -> ${status}` +
              (resName ? ` :: ${resName}` : "") +
              (resMeta && oldState.status !== status ? ` :: meta=${String(resMeta.name || resMeta.title || (typeof resMeta === 'string' ? resMeta : JSON.stringify(Object.keys(resMeta))))}` : "")
            );
          }
        });
        voice.audioPlayer.on("error", (e) => client.logger.error(`[VoiceDiag ${guildId}] player error: ${e.message}`));
        voice.audioPlayer.on("debug", (msg) => client.logger.log(`[VoiceDiag ${guildId}] PDBG ${String(msg).slice(0, 200)}`));
      }
    };

    client.distube.on("ffmpegDebug", (guildId, data) => {
      // el progress de ffmpeg (size=… time=… bitrate=…) es spam: NO se loguea.
      const line = String(data ?? "").trim();
      if (!line) return;
      if (/^size=\s*\d|^time=\s*\d|^frame=\s*\d|^fps=/i.test(line)) return;
      client.logger.log(`[FFMPEG ${guildId}] ${line.slice(0, 400)}`);
    });

    client.distube.on("initQueue", async (queue) => {
    queue.volume = client.config.options.defaultVolume;

    // Reset Auto DJ to off by default on every new play session,
    // PERO si estaba activo antes de un Stop/limpieza, se conserva
    // (así el refill vuelve a correr sin que el usuario reactive el botón).
    const guildId = queue.textChannel?.guildId || queue.guildId;
    const wasOn = client.autoDj?.get(guildId) === true;
    if (wasOn) {
      client.autoDj?.set(guildId, true);
    } else {
      client.autoDj?.delete(guildId);
      client.autoDjPrev?.delete(guildId);
    }

    // init auto resume for the queue
    await InitAutoResume(client, queue);
    instrumentVoice(queue);
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
