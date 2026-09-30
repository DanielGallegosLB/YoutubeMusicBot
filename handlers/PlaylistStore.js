const MAX_TRACKS_PER_PLAYLIST = 500;
const MAX_PATTERN_STEPS = 20;
const MAX_AUTODJ_SEEN = 800;
const FAVORITES_NAME = "canciones favoritas";

/**
 * Patrón por defecto: una RECOMENDACIÓN 🛸 y una ALEATORIA 🎲 en ciclo.
 * La 🎲 usa el resto de la lista que aún no sonó (siempre hay); la 🛸 usa las
 * favoritas con 👍/⭐ de los oyentes de la llamada, en orden de "score" y sin
 * repetirlas (aunque sean poquitas). Las que quedaron adentro de la lista pero
 * lejos de sonar se "adelantan" al hueco del AutoDJ sin duplicarse.
 */
const DEFAULT_AUTODJ_PATTERN = Object.freeze([
  Object.freeze({ type: "rec", userId: "*" }),
  Object.freeze({ type: "random" }),
]);

/**
 * Normaliza el patrón de intercalado del AutoDJ.
 * Acepta: [{type:"rec",userId}, {type:"random"}] → devuelve lo mismo ya validado,
 * o null si está vacío/inválido (eso significa: usar el default).
 */
function normalizeAutoDjPattern(pattern) {
  if (!Array.isArray(pattern) || !pattern.length) return null;
  const out = [];
  for (const step of pattern.slice(0, MAX_PATTERN_STEPS)) {
    if (!step || typeof step !== "object") continue;
    const type = step.type === "random" ? "random" : "rec";
    if (type === "random") out.push({ type: "random" });
    else out.push({ type: "rec", userId: String(step.userId || "*") });
  }
  return out.length ? out : null;
}

/**
 * Utilities for storing user playlists in client.music (JoshDB)
 * Data shape (per guild):
 *   key: `${guildId}.playlists.${userId}` -> { [playlistName: string]: Array<Track> }
 */
module.exports = {
  DEFAULT_AUTODJ_PATTERN,
  MAX_PATTERN_STEPS,
  normalizeAutoDjPattern,
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

  /** Da 👍 a una canción EN NOMBRE de otro usuario (dashboard/adm). Si la canción
   *  no está en sus "Canciones Favoritas", la guarda primero (con la metadata que
   *  manda el dashboard, sin resolver por yt-dlp) y le suma el like: así el pool
   *  de 🛸 del AutoDJ de ESE usuario gana una recomendación real.
   *  `track` = { url, name, title, thumbnail, uploader, duration, formattedDuration }.
   *  Devuelve { liked, created, likeCount, dislikeCount, score } o null si no hay url. */
  async likeForUser(client, guildId, userId, track) {
    if (!track || !track.url) return null;
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all["Canciones Favoritas"] || [];
    let existing = list.find((t) => t.url === track.url);
    let created = false;
    if (!existing) {
      existing = {
        url: track.url,
        name: track.name || track.title || track.url,
        title: track.title || track.name || null,
        thumbnail: track.thumbnail || null,
        uploader: track.uploader || null,
        duration: Number(track.duration) || 0,
        formattedDuration: track.formattedDuration || null,
        playCount: 0,
        likedBy: [],
        dislikedBy: [],
        savedAt: new Date().toISOString(),
      };
      list.push(existing);
      created = true;
    }
    existing.likedBy = existing.likedBy || [];
    existing.dislikedBy = existing.dislikedBy || [];
    const disIdx = existing.dislikedBy.indexOf(userId);
    if (disIdx !== -1) existing.dislikedBy.splice(disIdx, 1);
    if (!existing.likedBy.includes(userId)) existing.likedBy.push(userId);
    all["Canciones Favoritas"] = list;
    await Promise.all([
      client.music.set(key, all),
      this.trackLike(client, guildId, track.url, userId),
    ]);
    return {
      liked: true,
      created,
      likeCount: existing.likedBy.length,
      dislikeCount: existing.dislikedBy.length,
      score: existing.likedBy.length - existing.dislikedBy.length,
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
   * Only REAL favorites are used (con 👍 o guardadas a mano con ⭐): la lista
   * entera quedó llena (~500 por usuario) de canciones que una versión vieja
   * del bot guardaba automáticamente al sonar, y el bot terminaba poniéndolas.
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
      const sorted = (await this.getSortedFavorites(client, guildId, uid)).filter(
        (t) => t?.url && this.isRealFavorite(t) && !exclude.has(t.url)
      );
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

  // ── AutoDJ: qué canciones puede meter el bot ──
  //
  // "Favorita" para el AutoDJ = canción con AL MENOS UN 👍 (like real) o que el
  // usuario guardó a mano con ⭐ (track.manual). Antes el pool era la lista
  // "Canciones Favoritas" entera, que estaba llena (500+) de canciones que una
  // versión vieja del bot guardaba automáticamente al sonar, y el AutoDJ metía
  // temas que el usuario nunca había pedido.

  /** ¿Este track es una favorita "real" (con like o guardado a mano)? */
  isRealFavorite(track) {
    if (!track || !track.url) return false;
    if ((track.likedBy || []).length > 0) return true;
    if (track.manual === true) return true;
    return false;
  },

  /**
   * Pool del AutoDJ agrupado por usuario: { [userId]: Track[] } usando SOLO las
   * favoritas reales (con like o ⭐ manual), ordenadas por score.
   */
  async getAutoDjPoolsByUser(client, guildId, userIds) {
    const pools = {};
    for (const uid of userIds) {
      const favs = await this.getSortedFavorites(client, guildId, uid);
      const real = favs.filter((t) => this.isRealFavorite(t) && t.url);
      if (real.length) pools[uid] = real;
    }
    return pools;
  },

  /**
   * Canciones que los usuarios del canal efectivamente pidieron reproducir
   * (guardadas en `picks` al cargar una lista: la 1ª canción es la que el
   * usuario suele querer; sirve para cuando alguien sube una playlist de 300
   * temas "por error" y solo le importa el primero).
   */
  async getAutoDjPicks(client, guildId) {
    const data = (await this.getAutoDjState(client, guildId)) || {};
    return (data.picks || []).filter((p) => p && p.url);
  },

  /** Recorda la 1ª canción de una lista como candidata del AutoDJ (anillo LRU). */
  async addAutoDjPick(client, guildId, url, name) {
    if (!url) return;
    const data = (await this.getAutoDjState(client, guildId)) || {};
    data.picks = (data.picks || []).filter((p) => p.url !== url);
    data.picks.unshift({ url, name: name || null, at: Date.now() });
    if (data.picks.length > 30) data.picks.length = 30;
    await this.saveAutoDjState(client, guildId, data);
  },

  async removeAutoDjPick(client, guildId, url) {
    const data = (await this.getAutoDjState(client, guildId)) || {};
    data.picks = (data.picks || []).filter((p) => p.url !== url);
    await this.saveAutoDjState(client, guildId, data);
  },

  // ── Patrón de intercalado del AutoDJ (configurable en el dashboard) ──
  //
  // Es una lista ordenada de pasos que se repite en ciclo:
  //   { type: "rec", userId: "123" }  → una canción recomendada de ese usuario
  //   { type: "rec", userId: "*" }    → una recomendada de cualquiera
  //   { type: "random" }              → una "aleatoria" (otra favorita real)
  // Ej: [rec:dani, random, rec:fulano, random, rec:otro]

  async getAutoDjState(client, guildId) {
    return (await client.music.get(`${guildId}.autodj`).catch(() => null)) || {};
  },

  async saveAutoDjState(client, guildId, data) {
    await client.music.set(`${guildId}.autodj`, data || {});
  },

  /** Patrón de intercalado del guild (normalizado). Default = 1 rec : 1 aleatoria. */
  async getAutoDjPattern(client, guildId) {
    const data = await this.getAutoDjState(client, guildId);
    return normalizeAutoDjPattern(data?.pattern);
  },

  async setAutoDjPattern(client, guildId, pattern) {
    const data = await this.getAutoDjState(client, guildId);
    const norm = normalizeAutoDjPattern(pattern);
    if (!norm) {
      delete data.pattern;
      await this.saveAutoDjState(client, guildId, data);
      return null;
    }
    data.pattern = norm;
    data.patternUpdatedAt = Date.now();
    await this.saveAutoDjState(client, guildId, data);
    return norm;
  },

  /**
   * Historial PERSISTENTE de canciones que el AutoDJ ya puso en este server.
   * Sirve para que NO se repitan entre sesiones (la sesión se reinicia cada
   * vez que arranca el bot / se reabre el voice). Orden de inserción = orden
   * en el que se marcaron (lo más viejo adelante). Acotado: MAX_AUTODJ_SEEN.
   */
  async getAutoDjSeen(client, guildId) {
    const data = await this.getAutoDjState(client, guildId);
    return Array.isArray(data.seen) ? data.seen : [];
  },

  /** Persiste el historial completo de "ya puestas". Recibe un Map url→ts. */
  async saveAutoDjSeen(client, guildId, seenMap) {
    const data = await this.getAutoDjState(client, guildId);
    const urls = seenMap instanceof Map ? [...seenMap.keys()] : [];
    data.seen = urls.slice(-MAX_AUTODJ_SEEN);
    await this.saveAutoDjState(client, guildId, data);
    return data.seen;
  },

  /**
   * Quantas favoritas hay y cuántas son basura (sin like y sin ⭐ manual).
   * Lo usa el dashboard para mostrar "se van a limpiar N" antes de purgar.
   */
  async countUnlikedFavorites(client, guildId) {
    const out = { total: 0, real: 0, unliked: 0, users: 0 };
    const root = await client.music.get(guildId);
    if (!root || typeof root !== "object" || !root.playlists || typeof root.playlists !== "object") {
      return out;
    }
    for (const userId of Object.keys(root.playlists)) {
      const pl = root.playlists[userId];
      if (!pl || typeof pl !== "object") continue;
      let count = 0;
      for (const name of Object.keys(pl)) {
        const key = String(name).toLowerCase();
        const list = Array.isArray(pl[name]) ? pl[name] : [];
        if (key !== FAVORITES_NAME) continue;
        for (const t of list) {
          out.total++;
          if (this.isRealFavorite(t)) out.real++;
          else out.unliked++;
        }
        count += list.length;
      }
      if (count > 0) out.users++;
    }
    return out;
  },

  /**
   * Lista TODAS las "Canciones Favoritas" del guild con su estado de like/⭐,
   * para que el dashboard pueda buscar y verificar si un 👍 se guardó.
   * Devuelve [{ url, name, thumbnail, uploader, duration, likes, dislikes,
   *            plays, manual, real, savedAt, userId }] (máx `limit`).
   */
  async listGuildFavorites(client, guildId, limit) {
    const cap = Number.isInteger(limit) && limit > 0 ? limit : 1500;
    const out = [];
    const root = await client.music.get(guildId);
    if (!root || typeof root !== "object" || !root.playlists || typeof root.playlists !== "object") {
      return out;
    }
    for (const userId of Object.keys(root.playlists)) {
      const pl = root.playlists[userId];
      if (!pl || typeof pl !== "object") continue;
      for (const name of Object.keys(pl)) {
        if (String(name).toLowerCase() !== FAVORITES_NAME) continue;
        const list = Array.isArray(pl[name]) ? pl[name] : [];
        for (const t of list) {
          if (!t || typeof t !== "object") continue;
          out.push({
            url: t.url || null,
            name: t.name || t.title || "Sin título",
            thumbnail: t.thumbnail || null,
            uploader: (t.uploader && (t.uploader.name || t.uploader.url || t.uploader)) || null,
            duration: t.formattedDuration || t.duration || null,
            likes: Array.isArray(t.likedBy) ? t.likedBy.length : 0,
            dislikes: Array.isArray(t.dislikedBy) ? t.dislikedBy.length : 0,
            plays: Number(t.playCount) || 0,
            manual: t.manual === true,
            real: this.isRealFavorite(t),
            savedAt: t.savedAt || null,
            userId,
          });
        }
      }
    }
    return out.slice(0, cap);
  },

  /**
   * Limpia las "Canciones Favoritas" del server: BORRA las canciones que NADIE
   * tiene con like y que tampoco se guardaron a mano con ⭐ → la basura que una
   * versión vieja del bot guardaba sola (cada tema que sonaba, ~500/usuario).
   *
   * No hay archive ni restore: se eliminan de verdad (recuperable solo si el
   * usuario tiene la canción en su historial de reproducción y la vuelve a ⭐).
   *
   * Devuelve { removed, users, kept }.
   */
  async pruneUnlikedFavorites(client, guildId) {
    const root = await client.music.get(guildId);
    if (!root || typeof root !== "object" || !root.playlists || typeof root.playlists !== "object") {
      return { removed: 0, users: 0, kept: 0 };
    }
    const playlists = root.playlists;
    let removed = 0;
    let users = 0;
    let kept = 0;

    for (const userId of Object.keys(playlists)) {
      const pl = playlists[userId];
      if (!pl || typeof pl !== "object") continue;
      let dirty = false;

      for (const name of Object.keys(pl)) {
        if (String(name).toLowerCase() !== FAVORITES_NAME) continue;
        const list = Array.isArray(pl[name]) ? pl[name] : [];

        const good = list.filter((t) => this.isRealFavorite(t));
        const junk = list.filter((t) => !this.isRealFavorite(t));
        if (!junk.length) { kept += good.length; continue; }
        kept += good.length;
        removed += junk.length;
        pl[name] = good;
        dirty = true;
      }
      if (dirty) users++;
    }
    if (removed > 0) await client.music.set(`${guildId}.playlists`, playlists);
    return { removed, users, kept };
  },

  /** La lista "Canciones Favoritas" de un objeto de playlists (case-insensitive). */
  _favoritesListOf(playlists) {
    if (!playlists || typeof playlists !== "object") return { list: [], key: null };
    const key = Object.keys(playlists).find((n) => String(n).toLowerCase() === FAVORITES_NAME);
    const list = key && Array.isArray(playlists[key]) ? playlists[key] : [];
    return { list, key };
  },

  /** Basura de UN usuario: { total, real, unliked } de sus Favoritas. */
  async getUnlikedFavoritesForUser(client, guildId, userId) {
    const out = { total: 0, real: 0, unliked: 0 };
    const all = (await client.music.get(`${guildId}.playlists.${userId}`).catch(() => null)) || {};
    const { list } = this._favoritesListOf(all);
    for (const t of list) {
      out.total++;
      if (this.isRealFavorite(t)) out.real++;
      else out.unliked++;
    }
    return out;
  },

  /**
   * Elimina SOLO la basura (sin 👍 ni ⭐ manual) de las "Canciones Favoritas"
   * de un usuario puntual (no del server entero). Devuelve cuánto borró,
   * cuánto dejó y 3 ejemplos de lo eliminado.
   */
  async pruneUnlikedFavoritesForUser(client, guildId, userId) {
    const key = `${guildId}.playlists.${userId}`;
    const all = (await client.music.get(key).catch(() => null)) || {};
    const { list, key: favKey } = this._favoritesListOf(all);
    const good = list.filter((t) => this.isRealFavorite(t));
    const junk = list.filter((t) => !this.isRealFavorite(t));
    if (junk.length && favKey) {
      all[favKey] = good;
      await client.music.set(key, all);
    }
    return {
      removed: junk.length,
      kept: good.length,
      samples: junk.slice(0, 3).map((t) => t && (t.name || t.title)) || [],
    };
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
    // Quién tiene ESTA canción en sus "Canciones Favoritas" (o sea, a quién le
    // gusta). Es lo que se muestra en la cola para saber a quién le gusta cada tema.
    const ownerIds = [];
    const pushUnique = (arr, id) => { if (!arr.includes(id)) arr.push(id); };
    for (const userId of Object.keys(allPlaylists)) {
      const userPlaylists = allPlaylists[userId];
      const favs = userPlaylists?.["Canciones Favoritas"] || [];
      for (const t of favs) {
        if (t.url === trackUrl) {
          plays += (t.playCount || 0);
          // Solo una favorita REAL (con 👍 o guardada a mano ⭐) cuenta como
          // "dueña" del tema. Antes aparecía como 👤 cualquiera que tuviera la
          // canción en Favoritas, incluso la basura que una versión vieja del
          // bot guardaba sola al reproducirse (faz pensaba que otros le dieron
          // like cuando era puro autoguardado).
          if (this.isRealFavorite(t)) {
            for (const uid of (t.likedBy || [])) pushUnique(likedByIds, uid);
            for (const uid of (t.dislikedBy || [])) pushUnique(dislikedByIds, uid);
            pushUnique(ownerIds, userId);
          }
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
      owners: await resolveNames(ownerIds),
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
