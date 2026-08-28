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

  /** Delete a playlist; returns true if deleted */
  async delete(client, guildId, userId, name) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    if (!all[name]) return false;
    delete all[name];
    await client.music.set(key, all);
    return true;
  },

  /** Toggle like on a track by URL (player button) */
  async toggleLikeByUrl(client, guildId, userId, name, trackUrl) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    const track = list.find((t) => t.url === trackUrl);
    if (!track) return null;
    if (!track.likedBy) track.likedBy = [];
    if (!track.dislikedBy) track.dislikedBy = [];
    // Remove from disliked if present
    const disIdx = track.dislikedBy.indexOf(userId);
    if (disIdx !== -1) track.dislikedBy.splice(disIdx, 1);
    // Toggle like
    const likedIdx = track.likedBy.indexOf(userId);
    if (likedIdx === -1) {
      track.likedBy.push(userId);
    } else {
      track.likedBy.splice(likedIdx, 1);
    }
    all[name] = list;
    await client.music.set(key, all);
    return {
      liked: likedIdx === -1,
      likeCount: track.likedBy.length,
      dislikeCount: track.dislikedBy.length,
      score: track.likedBy.length - track.dislikedBy.length,
    };
  },

  /** Toggle dislike on a track by URL (player button) */
  async toggleDislikeByUrl(client, guildId, userId, name, trackUrl) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    const track = list.find((t) => t.url === trackUrl);
    if (!track) return null;
    if (!track.likedBy) track.likedBy = [];
    if (!track.dislikedBy) track.dislikedBy = [];
    // Remove from liked if present
    const likedIdx = track.likedBy.indexOf(userId);
    if (likedIdx !== -1) track.likedBy.splice(likedIdx, 1);
    // Toggle dislike
    const disIdx = track.dislikedBy.indexOf(userId);
    if (disIdx === -1) {
      track.dislikedBy.push(userId);
    } else {
      track.dislikedBy.splice(disIdx, 1);
    }
    all[name] = list;
    await client.music.set(key, all);
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
  async getInterleavedFavorites(client, guildId, userIds) {
    const userLists = [];
    for (const uid of userIds) {
      const sorted = await this.getSortedFavorites(client, guildId, uid);
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

  /** Get global stats (likes, dislikes, plays) for a track URL across all users in a guild */
  async getGlobalTrackStats(client, guildId, trackUrl) {
    const allPlaylists = await client.music.get(`${guildId}.playlists`) || {};
    let likes = 0;
    let dislikes = 0;
    let plays = 0;
    for (const userId of Object.keys(allPlaylists)) {
      const userPlaylists = allPlaylists[userId];
      const favs = userPlaylists?.["Canciones Favoritas"] || [];
      for (const t of favs) {
        if (t.url === trackUrl) {
          likes += (t.likedBy || []).length;
          dislikes += (t.dislikedBy || []).length;
          plays += (t.playCount || 0);
          break;
        }
      }
    }
    return { likes, dislikes, plays };
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
    await client.music.set(key, all);
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
