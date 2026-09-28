const MAX_TRACKS_PER_PLAYLIST = 500;

/**
 * Utilities for storing user playlists in client.music (JoshDB)
 * Data shape (per guild):
 *   key: `${guildId}.playlists.${userId}` -> { [playlistName: string]: Array<Track> }
 */
module.exports = {
  /**
   * Ensure the user playlists object exists and return it
   */
  async getAll(client, guildId, userId) {
    const key = `${guildId}.playlists.${userId}`;
    await client.music.ensure(key, {});
    return (await client.music.get(key)) || {};
  },

  /**
   * Get a single playlist array by name (case-sensitive store, case-insensitive lookup)
   */
  async get(client, guildId, userId, name) {
    const all = await this.getAll(client, guildId, userId);
    const entry = Object.entries(all).find(([n]) => n.toLowerCase() === String(name).toLowerCase());
    return entry ? { name: entry[0], tracks: entry[1] || [] } : null;
  },

  /** Create a playlist if missing */
  async create(client, guildId, userId, name) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    if (!all[name]) {
      all[name] = [];
      await client.music.set(key, all);
    }
    return { name, tracks: all[name] };
  },

  /** Add one or many tracks to a playlist; increments playCount on duplicates */
  async addTracks(client, guildId, userId, name, tracks) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const existing = all[name] || [];
    const existingMap = new Map();
    for (let i = 0; i < existing.length; i++) {
      const t = existing[i];
      const keyStr = t?.url ? `u:${t.url}` : `n:${(t?.name || '').toLowerCase()}|${t?.duration || 0}`;
      existingMap.set(keyStr, i);
    }
    let addedCount = 0;
    for (const t of tracks) {
      const keyStr = t?.url ? `u:${t.url}` : `n:${(t?.name || '').toLowerCase()}|${t?.duration || 0}`;
      const existingIdx = existingMap.get(keyStr);
      if (existingIdx !== undefined) {
        // Track already exists; do not auto-increment playCount here (counted on actual play)
      } else {
        t.playCount = 0;
        t.likedBy = [];
        t.dislikedBy = [];
        existing.push(t);
        existingMap.set(keyStr, existing.length - 1);
        addedCount++;
        if (existing.length >= MAX_TRACKS_PER_PLAYLIST) break;
      }
    }
    all[name] = existing.slice(0, MAX_TRACKS_PER_PLAYLIST);
    await client.music.set(key, all);
    return addedCount;
  },

  /** Remove a track by 1-based index; returns removed track or null */
  async removeTrack(client, guildId, userId, name, index1) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    const idx = Number(index1) - 1;
    if (idx < 0 || idx >= list.length) return null;
    const [removed] = list.splice(idx, 1);
    all[name] = list;
    await client.music.set(key, all);
    return removed || null;
  },

  /** Remove multiple tracks by 1-based indices; returns count of removed tracks */
  async removeTracks(client, guildId, userId, name, indices1) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    const idxSet = new Set(indices1.map((i) => Number(i) - 1).filter((i) => i >= 0 && i < list.length));
    if (!idxSet.size) return 0;
    const newList = list.filter((_, i) => !idxSet.has(i));
    const removedCount = list.length - newList.length;
    all[name] = newList;
    await client.music.set(key, all);
    return removedCount;
  },

  /** Remove all tracks except the first N; returns count of removed tracks */
  async clearExcept(client, guildId, userId, name, keepFirst) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    if (list.length <= keepFirst) return 0;
    const removedCount = list.length - keepFirst;
    all[name] = list.slice(0, keepFirst);
    await client.music.set(key, all);
    return removedCount;
  },

  /** Remove ALL tracks from a playlist; returns count of removed tracks */
  async clearAll(client, guildId, userId, name) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    const removedCount = list.length;
    all[name] = [];
    await client.music.set(key, all);
    return removedCount;
  },

  /** Vacía la lista "Canciones Favoritas" de TODOS los usuarios del servidor y
   *  devuelve `{ removed, users }` (canciones eliminadas / usuarios afectados).
   *  Conserva el resto de playlists de cada usuario (y trackstats / autodj).
   *  Usa un solo get + set del árbol de la guild para no iterar miembros. */
  async clearGuildFavorites(client, guildId) {
    const root = await client.music.get(guildId);
    if (!root || typeof root !== "object" || !root.playlists || typeof root.playlists !== "object") {
      return { removed: 0, users: 0 };
    }
    const playlists = root.playlists;
    const target = "canciones favoritas";
    let removed = 0;
    let users = 0;
    for (const userId of Object.keys(playlists)) {
      const pl = playlists[userId];
      if (!pl || typeof pl !== "object") continue;
      let dirty = false;
      for (const name of Object.keys(pl)) {
        if (String(name).toLowerCase() === target) {
          removed += Array.isArray(pl[name]) ? pl[name].length : 0;
          delete pl[name];
          dirty = true;
        }
      }
      if (dirty) users++;
    }
    await client.music.set(`${guildId}.playlists`, playlists);
    return { removed, users };
  },

  // ── Stats globales por canción en el gremio (persisten aunque se quiten de
  // las favoritas: likes/dislikes/plays NO viven dentro del track de favoritos,
  // sino en un store aparte por url). ──

  /** Leer el store de stats del gremio: { [url]: { plays, likedBy[], dislikedBy[] } } */
  async guildStats(client, guildId) {
    const key = `${guildId}.trackstats`;
    await client.music.ensure(key, {});
    return (await client.music.get(key)) || {};
  },

  async saveGuildStats(client, guildId, stats) {
    await client.music.set(`${guildId}.trackstats`, stats);
  },

  /** Registra un like global de un usuario a una canción (sin duplicar el mismo user). */
  async trackLike(client, guildId, trackUrl, userId) {
    if (!trackUrl) return;
    const st = await this.guildStats(client, guildId);
    const e = st[trackUrl] || { plays: 0, likedBy: [], dislikedBy: [] };
    e.likedBy = e.likedBy || [];
    e.dislikedBy = e.dislikedBy || [];
    if (!e.likedBy.includes(userId)) e.likedBy.push(userId);
    const di = e.dislikedBy.indexOf(userId);
    if (di !== -1) e.dislikedBy.splice(di, 1);
    st[trackUrl] = e;
    await this.saveGuildStats(client, guildId, st);
  },

  /** Registra un dislike global de un usuario a una canción (sin duplicar el mismo user). */
  async trackDislike(client, guildId, trackUrl, userId) {
    if (!trackUrl) return;
    const st = await this.guildStats(client, guildId);
    const e = st[trackUrl] || { plays: 0, likedBy: [], dislikedBy: [] };
    e.likedBy = e.likedBy || [];
    e.dislikedBy = e.dislikedBy || [];
    if (!e.dislikedBy.includes(userId)) e.dislikedBy.push(userId);
    const li = e.likedBy.indexOf(userId);
    if (li !== -1) e.likedBy.splice(li, 1);
    st[trackUrl] = e;
    await this.saveGuildStats(client, guildId, st);
  },

  /** Registra una reproducción global de una canción en el gremio. */
  async trackPlay(client, guildId, trackUrl) {
    if (!trackUrl) return;
    const st = await this.guildStats(client, guildId);
    const e = st[trackUrl] || { plays: 0, likedBy: [], dislikedBy: [] };
    e.plays = (e.plays || 0) + 1;
    st[trackUrl] = e;
    await this.saveGuildStats(client, guildId, st);
  },

  /** Delete a playlist; returns true if deleted */
  async delete(client, guildId, userId, name) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    if (!all[name]) return false;
    delete all[name];
    await client.music.set(key, all);
    return true;
  },

  /** Add a like on a track by URL (accumulates across plays; each user can like once per play) */
  async likeTrackByUrl(client, guildId, userId, name, trackUrl) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    const track = list.find((t) => t.url === trackUrl);
    if (!track) return null;
    if (!track.likedBy) track.likedBy = [];
    if (!track.dislikedBy) track.dislikedBy = [];
    // Remove a dislike for this user for this play if present
    const disIdx = track.dislikedBy.indexOf(userId);
    if (disIdx !== -1) track.dislikedBy.splice(disIdx, 1);
    // Accumulate a like (allows multiple likes per user across different plays)
    track.likedBy.push(userId);
    all[name] = list;
    await Promise.all([
      client.music.set(key, all),
      this.trackLike(client, guildId, trackUrl, userId),
    ]);
    return {
      liked: true,
      likeCount: track.likedBy.length,
      dislikeCount: track.dislikedBy.length,
      score: track.likedBy.length - track.dislikedBy.length,
    };
  },

  /** Add a dislike on a track by URL (accumulates across plays; each user can dislike once per play) */
  async dislikeTrackByUrl(client, guildId, userId, name, trackUrl) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    const track = list.find((t) => t.url === trackUrl);
    if (!track) return null;
    if (!track.likedBy) track.likedBy = [];
    if (!track.dislikedBy) track.dislikedBy = [];
    // Remove a like for this user for this play if present
    const likedIdx = track.likedBy.indexOf(userId);
    if (likedIdx !== -1) track.likedBy.splice(likedIdx, 1);
    // Accumulate a dislike
    track.dislikedBy.push(userId);
    all[name] = list;
    await Promise.all([
      client.music.set(key, all),
      this.trackDislike(client, guildId, trackUrl, userId),
    ]);
    return {
      liked: false,
      likeCount: track.likedBy.length,
      dislikeCount: track.dislikedBy.length,
      score: track.likedBy.length - track.dislikedBy.length,
    };
  },

  /** Get favorites sorted by score (likes - dislikes) + playCount */
  async getSortedFavorites(client, guildId, userId) {
    const all = await this.getAll(client, guildId, userId);
    const favs = all["Canciones Favoritas"] || [];
    return [...favs].sort((a, b) => {
      const aScore = ((a.likedBy || []).length - (a.dislikedBy || []).length) * 10 + (a.playCount || 1);
      const bScore = ((b.likedBy || []).length - (b.dislikedBy || []).length) * 10 + (b.playCount || 1);
      return bScore - aScore;
    });
  },

  /** Sort favorites by score and save the order to DB */
  async sortFavorites(client, guildId, userId) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const favs = all["Canciones Favoritas"] || [];
    favs.sort((a, b) => {
      const aScore = ((a.likedBy || []).length - (a.dislikedBy || []).length) * 10 + (a.playCount || 1);
      const bScore = ((b.likedBy || []).length - (b.dislikedBy || []).length) * 10 + (b.playCount || 1);
      return bScore - aScore;
    });
    all["Canciones Favoritas"] = favs;
    await client.music.set(key, all);
    return favs;
  },

  /** Rename a playlist; returns true if renamed */
  async rename(client, guildId, userId, oldName, newName) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    if (!all[oldName]) return false;
    if (all[newName]) return false;
    all[newName] = all[oldName];
    delete all[oldName];
    await client.music.set(key, all);
    return true;
  },

  /**
   * Interleave favorites from multiple users in round-robin order.
   * Each user's favorites are sorted by their personal score.
   * Returns a deduplicated array where songs cycle: A#1, B#1, A#2, B#2, ...
   * @param {Client} client
   * @param {string} guildId
   * @param {string[]} userIds - array of user IDs in the voice channel
   * @returns {Array} interleaved track list
   */
  async getInterleavedFavorites(client, guildId, userIds, excludes = {}) {
    const userLists = [];
    for (const uid of userIds) {
      const exclude = new Set(excludes?.[uid] || []);
      const sorted = (await this.getSortedFavorites(client, guildId, uid)).filter((t) => !exclude.has(t.url));
      if (sorted.length > 0) userLists.push(sorted);
    }
    if (userLists.length === 0) return [];
    if (userLists.length === 1) return userLists[0];

    const seen = new Set();
    const result = [];
    let added = true;
    let round = 0;
    while (added) {
      added = false;
      for (const list of userLists) {
        const track = list[round];
        if (track && track.url && !seen.has(track.url)) {
          seen.add(track.url);
          result.push(track);
          added = true;
        }
      }
      round++;
      if (round > 1000) break;
    }
    return result;
  },

  /** Get the per-user AutoDJ exclusion lists for a guild: { [userId]: [urls...] } */
  async getAutodjExcludes(client, guildId) {
    const data = (await client.music.get(`${guildId}.autodj`).catch(() => null)) || {};
    return data?.exclude || {};
  },

  /** Add a URL to a user's AutoDJ exclude list (persistent). Returns the updated list */
  async addAutodjExclude(client, guildId, userId, url) {
    const data = (await client.music.get(`${guildId}.autodj`).catch(() => null)) || {};
    data.exclude = data.exclude || {};
    data.exclude[userId] = data.exclude[userId] || [];
    if (!data.exclude[userId].includes(url)) data.exclude[userId].push(url);
    await client.music.set(`${guildId}.autodj`, data);
    return data.exclude[userId];
  },

  /** Get the AutoDJ skip counters per user: { [url]: { [userId]: count } } */
  async getAutodjSkips(client, guildId) {
    const data = (await client.music.get(`${guildId}.autodj`).catch(() => null)) || {};
    return data?.skips || {};
  },

  /** Get global stats (likes, dislikes, plays) for a track URL across all users in a guild */
  async getGlobalTrackStats(client, guildId, trackUrl, allPlaylists) {
    if (!allPlaylists) allPlaylists = await client.music.get(`${guildId}.playlists`) || {};
    let plays = 0;
    const likedByIds = [];
    const dislikedByIds = [];
    const likedNames = [];
    const dislikedNames = [];
    const pushUnique = (arr, id) => { if (!arr.includes(id)) arr.push(id); };
    for (const userId of Object.keys(allPlaylists)) {
      const userPlaylists = allPlaylists[userId];
      const favs = userPlaylists?.["Canciones Favoritas"] || [];
      for (const t of favs) {
        if (t.url === trackUrl) {
          plays += (t.playCount || 0);
          for (const uid of (t.likedBy || [])) pushUnique(likedByIds, uid);
          for (const uid of (t.dislikedBy || [])) pushUnique(dislikedByIds, uid);
          break;
        }
      }
    }
    // Sum the persistent guild stats too (survive favorites removal), de-duplicating user IDs.
    const gStat = (await this.guildStats(client, guildId))[trackUrl];
    if (gStat) {
      plays = Math.max(plays, gStat.plays || 0);
      for (const uid of (gStat.likedBy || [])) pushUnique(likedByIds, uid);
      for (const uid of (gStat.dislikedBy || [])) pushUnique(dislikedByIds, uid);
    }
    const resolveNames = (ids) => Promise.all(ids.map(async (id) => {
      const member = await client.users.fetch(id).catch(() => null);
      return member?.username || id;
    }));
    likedNames.push(...await resolveNames(likedByIds));
    dislikedNames.push(...await resolveNames(dislikedByIds));
    return {
      likes: likedByIds.length,
      dislikes: dislikedByIds.length,
      plays,
      likedBy: likedNames,
      dislikedBy: dislikedNames,
    };
  },

  /** Increment play count for a track by URL (called when it actually starts playing). Returns true if found */
  async countPlay(client, guildId, userId, name, trackUrl) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    const track = list.find((t) => t.url === trackUrl);
    if (!track) return false;
    track.playCount = typeof track.playCount === "number" && track.playCount > 0 ? track.playCount + 1 : 1;
    all[name] = list;
    await Promise.all([
      client.music.set(key, all),
      this.trackPlay(client, guildId, trackUrl),
    ]);
    return true;
  },

  /** Serialize a DisTube Song to a plain Track object */
  serializeSong(song, user) {
    if (!song) return null;
    return {
      name: song.name || song.playlist?.name || "Unknown",
      url: song.url,
      duration: song.duration || 0,
      formattedDuration: song.formattedDuration || null,
      thumbnail: song.thumbnail || null,
      uploader: song.uploader?.name || null,
      source: song.source || null,
      requestedBy: user?.id || null,
      savedAt: Date.now(),
    };
  },
};
