const MAX_TRACKS_PER_PLAYLIST = 500;
const MAX_PATTERN_STEPS = 20;
const MAX_AUTODJ_SEEN = 800;
const FAVORITES_NAME = "canciones favoritas";

// Resolver NOMBRES de Discord es la parte lenta de getGlobalTrackStats (un fetch
// a la API por id). Con muchos 👍 por canción eso se comía el timeout de 4s del
// render y el embed parpadeaba entre los stats reales y "Sin stats aún". Se
// cachea id→nombre (los nombres no cambian) y se consulta primero el cache de
// miembros del guild, que ya está en memoria y no cuesta nada.
const _nameCache = new Map();
const _resolveName = async (client, guild, id) => {
  const hit = _nameCache.get(id);
  if (hit) return hit;
  let name = null;
  const member = guild?.members?.cache?.get(id);
  if (member?.user?.username) name = member.user.username;
  else {
    const u = client.users?.cache?.get(id);
    if (u?.username) name = u.username;
    else name = await client.users.fetch(id).then((x) => x?.username).catch(() => null);
  }
  if (!name) return id; // sin cachear: aún no lo sabemos, se reintenta
  if (_nameCache.size > 5000) _nameCache.clear();
  _nameCache.set(id, name);
  return name;
};

// JoshDB (Mongo/JSON) guarda TODAS las claves de un guild en un SOLO documento
// (playlists, trackstats, autodj…). Cada mutación es get→mutar→set: si dos
// flujos (p. ej. un 👍 mientras suena la canción) hacen el get a la vez, el úl­
// timo set reescribe la lista con un snapshot viejo y pierde el like/play. Este
// lock POR GREMIO serializa la sección crítica completa (leer→mutar→guardar).
const _guildLocks = new Map();
async function _runGuildLocked(guildId, fn) {
  const key = String(guildId);
  const prev = _guildLocks.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  _guildLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

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
   * Clave canónica de una URL: el MISMO video puede guardarse en favoritas con
   * variantes (`watch?v=X&list=Y&index=1` vs limpio, mayúsculas, etc.) y cada
   * variante se convertía en un "track" aparte con su propio conteo (por eso un
   * 👍 repetido de "Toda la noche" seguía mostrando 👍1). Aquí solo importa el
   * VIDEO id: así likes/dislikes/plays de todas las variantes se suman.
   */
  canonUrlKey(u) {
    if (typeof u !== "string" || !u) return u;
    try {
      const nu = new URL(u.trim());
      if (/youtube\.com|youtu\.be/i.test(nu.host || "")) {
        const v = nu.searchParams.get("v");
        if (v) return `yt:${v}`;
        if (nu.pathname.startsWith("/shorts/")) return `yt:${nu.pathname.split("/")[2] || u}`;
      }
    } catch {}
    return u.trim();
  },
  findTrackByCanon(list, url) {
    const k = this.canonUrlKey(url);
    return (list || []).find((t) => t?.url && this.canonUrlKey(t.url) === k);
  },
  /**
   * Ensure the user playlists object exists and return it
   */
  async getAll(client, guildId, userId) {
    const key = `${guildId}.playlists.${userId}`;
    // Lectura PURA (sin ensure): el ensure sobre un path reescribía el guild
    // completo y generaba escrituras fuera del lock que pisaban el likedBy.
    const all = await client.music.get(key);
    return all && typeof all === "object" ? all : {};
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
    // Lectura PURA (sin ensure) por la misma razón que getAll.
    const st = await client.music.get(key);
    return st && typeof st === "object" ? st : {};
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

  /** Add a like on a track by URL (acumula sin tope: cada 👍 suma) */
  async likeTrackByUrl(client, guildId, userId, name, trackUrl) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    // Match por clave canónica: no importa la variante de URL con la que suena.
    let track = this.findTrackByCanon(list, trackUrl);
    if (!track) track = list.find((t) => t.url === trackUrl);
    if (!track) return null;
    if (!track.likedBy) track.likedBy = [];
    if (!track.dislikedBy) track.dislikedBy = [];
    // Remove a dislike for this user for this play if present
    const disIdx = track.dislikedBy.indexOf(userId);
    if (disIdx !== -1) track.dislikedBy.splice(disIdx, 1);
    // Acumula cada 👍 (sin tope): el mismo usuario sube el contador en cada
    // clic, tanto desde el embed como desde el dashboard.
    //
    // Si el store global ya tiene un 👍 de ESTE usuario y la favorita no lo
    // tenía (un set en carrera lo dejó solo en gStat), primero se siembra esa
    // base. Sin esto el acumulador arrancaba en 0: la canción que ya tenía 1
    // like seguía mostrando 1 después del primer click, y recién al segundo
    // markaba 2 — "como si el like no se guardara".
    const g0 = (await this.guildStats(client, guildId))[trackUrl];
    if (g0?.likedBy?.includes(userId) && !track.likedBy.includes(userId)) {
      track.likedBy.push(userId);
    }
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
   *  `claimKey` opcional: si se pasa, aplica el tope "máx 1 👍 por usuario por
   *  reproducción" usando `client.likeClaims` (mismo mapa que el botón del embed).
   *  Devuelve { liked, created, likeCount, dislikeCount, score } o null si no hay url. */
  async likeForUser(client, guildId, userId, track, claimKey) {
    if (!track || !track.url) return null;
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all["Canciones Favoritas"] || [];
    // Match CANÓNICO (variantes `&list=` = misma canción) para no crear una
    // entrada duplicada si el tema se guardó con otra variante de URL.
    let existing = this.findTrackByCanon(list, track.url) || list.find((t) => t.url === track.url);
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
    // Tope por reproducción (si el dashboard manda el claimKey de la canción
    // que está sonando): si este usuario ya sumó en esta reproducción, no suma.
    if (claimKey) {
      if (!client.likeClaims) client.likeClaims = new Map();
      if (client.likeClaims.size > 5000) client.likeClaims.clear();
      let claims = client.likeClaims.get(claimKey);
      if (!claims) { claims = new Set(); client.likeClaims.set(claimKey, claims); }
      if (claims.has(userId)) {
        return {
          liked: true,
          created: false,
          likeCount: existing.likedBy.length,
          dislikeCount: existing.dislikedBy.length,
          score: existing.likedBy.length - existing.dislikedBy.length,
          alreadyThisPlay: true,
        };
      }
      claims.add(userId);
    }
    const disIdx = existing.dislikedBy.indexOf(userId);
    if (disIdx !== -1) existing.dislikedBy.splice(disIdx, 1);
    // Acumula cada 👍 que manda el dashboard (para que el total SUBA tanto en el
    // dashboard como en el embed), con el tope por reproducción de arriba.
    existing.likedBy.push(userId);
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

  /** Add a dislike on a track by URL (acumula sin tope: cada 👎 suma) */
  async dislikeTrackByUrl(client, guildId, userId, name, trackUrl) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    let track = this.findTrackByCanon(list, trackUrl);
    if (!track) track = list.find((t) => t.url === trackUrl);
    if (!track) return null;
    if (!track.likedBy) track.likedBy = [];
    if (!track.dislikedBy) track.dislikedBy = [];
    // Remove a like for this user for this play if present
    const likedIdx = track.likedBy.indexOf(userId);
    if (likedIdx !== -1) track.likedBy.splice(likedIdx, 1);
    // Acumula cada 👎 (sin tope).
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
   * Pool de RESGUARDE: las favoritas que NO son "reales" (sin 👍 ni ⭐ manual).
   *
   * Antes estas no entraban nunca al AutoDJ, y eso dejaba el pool real en 19
   * canciones: cuando se habían visto todas, el bot empezaba a reciclar las
   * mismas y se oía la misma canción cada poco. Ahora son el segundo escalón:
   * solo se usan cuando ya no queda ninguna real sin ver, y nunca si alguien le
   * puso 👎. Siguen sin ser la primera opción (eso no se pierde).
   */
  async getAutoDjFallbackPoolsByUser(client, guildId, userIds) {
    const pools = {};
    for (const uid of userIds) {
      const all = (await client.music.get(`${guildId}.playlists.${uid}`).catch(() => null)) || {};
      const { list } = this._favoritesListOf(all);
      const rest = list.filter((t) => t?.url && !this.isRealFavorite(t) && (t.dislikedBy || []).length === 0);
      if (rest.length) pools[uid] = rest;
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
    // Stats persistentes del gremio (guildStats): el bot acumula ahí los 👍/👎/▶️
    // POR URL. Se cruzan por clave canónica (variantes `&list=` = misma canción)
    // para que el dashboard muestre lo MISMO que el embed/cola, aunque en la
    // Favorita el like no esté en `likedBy` (una escritura en carrera pudo
    // dejarlo solo en el store de stats, y ese store es el que lleva la cuenta).
    const gStat = await this.guildStats(client, guildId).catch(() => ({}));
    for (const userId of Object.keys(root.playlists)) {
      const pl = root.playlists[userId];
      if (!pl || typeof pl !== "object") continue;
      for (const name of Object.keys(pl)) {
        if (String(name).toLowerCase() !== FAVORITES_NAME) continue;
        const list = Array.isArray(pl[name]) ? pl[name] : [];
        for (const t of list) {
          if (!t || typeof t !== "object") continue;
          const url = t.url || null;
          const entryLikes = Array.isArray(t.likedBy) ? t.likedBy.length : 0;
          const entryDislikes = Array.isArray(t.dislikedBy) ? t.dislikedBy.length : 0;
          let likedGlobally = false;
          let dislikedGlobally = false;
          let gPlays = 0;
          for (const k of Object.keys(gStat)) {
            if (this.canonUrlKey(k) !== this.canonUrlKey(url)) continue;
            const e = gStat[k] || {};
            gPlays = Math.max(gPlays, Number(e.plays) || 0);
            if ((e.likedBy || []).includes(userId)) likedGlobally = true;
            if ((e.dislikedBy || []).includes(userId)) dislikedGlobally = true;
          }
          out.push({
            url,
            name: t.name || t.title || "Sin título",
            thumbnail: t.thumbnail || null,
            uploader: (t.uploader && (t.uploader.name || t.uploader.url || t.uploader)) || null,
            duration: t.formattedDuration || t.duration || null,
            likes: Math.max(entryLikes, likedGlobally ? 1 : 0),
            dislikes: Math.max(entryDislikes, dislikedGlobally ? 1 : 0),
            plays: Math.max(Number(t.playCount) || 0, gPlays),
            manual: t.manual === true,
            real: this.isRealFavorite(t) || likedGlobally || dislikedGlobally,
            savedAt: t.savedAt || null,
            userId,
          });
        }
      }
    }
    // Canciones con stats (reproducciones/likes) pero SIN entrada en Favoritas
    // (purgadas como basura, autoguardado viejo o likes que quedaron solo en
    // gStat antes de los locks): se listan igual como filas "virtuales" para que
    // en el dashboard sean encontrables y se vea que la info existe.
    const virtual = [];
    for (const k of Object.keys(gStat)) {
      const e = gStat[k] || {};
      const likesArr = e.likedBy || [];
      const dislikesArr = e.dislikedBy || [];
      const plays = Number(e.plays) || 0;
      if (!likesArr.length && !dislikesArr.length && !plays) continue;
      const canon = this.canonUrlKey(k);
      if (!k || out.some((o) => o.url && this.canonUrlKey(o.url) === canon)) continue;
      if (virtual.some((o) => this.canonUrlKey(o.url) === canon)) continue;
      virtual.push({
        url: k,
        name: k,
        thumbnail: null,
        uploader: null,
        duration: null,
        likes: likesArr.length,
        dislikes: dislikesArr.length,
        plays,
        manual: false,
        real: likesArr.length > 0,
        savedAt: null,
        userId: likesArr[0] || dislikesArr[0] || null,
        virtual: true,
      });
    }
    out.push(...virtual);
    return out.slice(0, cap);
  },

  /** Verifica dónde quedó el 👍/👎 de un usuario para una canción: cuántos likes
   *  hay en la Favorita (`likedBy`) y cuántos en el store de stats del gremio.
   *  Sirve para diagnosticar cuando el embed muestra 👍 pero la Favorita no. */
  async verifyLike(client, guildId, userId, name, trackUrl) {
    try {
      const all = await this.getAll(client, guildId, userId);
      const list = all[name] || [];
      const track = this.findTrackByCanon(list, trackUrl) || list.find((t) => t.url === trackUrl);
      const gStat = await this.guildStats(client, guildId);
      let gStatLikes = 0;
      let gStatDislikes = 0;
      for (const k of Object.keys(gStat)) {
        if (this.canonUrlKey(k) !== this.canonUrlKey(trackUrl)) continue;
        gStatLikes += (gStat[k]?.likedBy || []).length;
        gStatDislikes += (gStat[k]?.dislikedBy || []).length;
      }
      return {
        favLikes: (track && Array.isArray(track.likedBy) ? track.likedBy.length : 0) || 0,
        favDislikes: (track && Array.isArray(track.dislikedBy) ? track.dislikedBy.length : 0) || 0,
        gStatLikes,
        gStatDislikes,
      };
    } catch {
      return null;
    }
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

  /**
   * Registra que `userId` salteó una canción.
   *
   * NO es un veto ni un ban: es una señal de "no la repitas tanto". El AutoDJ
   * usa el contador como PESO (a más skips, menos probabilidad de elegirla)
   * y solo para quien la saltó. Se guarda por CLAVE CANÓNICA para que todas
   * las variantes del mismo video (`watch?v=X`, `watch?v=X&list=Y`, `youtu.be/X`)
   * cuenten como una sola canción en lugar de repartirse el contador.
   *
   * @param {MusicBot} client
   * @param {String} guildId
   * @param {String} userId  quién saltó (si falta, no se registra)
   * @param {String|Object} track  la canción (o su URL)
   * @returns {Promise<Number>} skips acumulados de ESE usuario para ESE tema
   */
  async recordTrackSkip(client, guildId, userId, track) {
    const url = typeof track === "string" ? track : track?.url;
    if (!userId || !url) return 0;
    const key = this.canonUrlKey(url) || url;
    const data = (await client.music.get(`${guildId}.autodj`).catch(() => null)) || {};
    data.skips = data.skips || {};
    // Una versión anterior guardaba la URL CRUDA como clave. Al sumar, se pesa
    // también esa entrada y se borra: si no, el mismo skip quedaría partido en
    // dos contadores y la canción nunca llegaría a weigh down del todo.
    const legacy = typeof url === "string" ? url.trim() : "";
    let base = 0;
    if (legacy && legacy !== key && data.skips[legacy]) {
      base = Number(data.skips[legacy][userId]) || 0;
      delete data.skips[legacy];
    }
    data.skips[key] = data.skips[key] || {};
    const cnt = base + (Number(data.skips[key][userId]) || 0) + 1;
    data.skips[key][userId] = cnt;
    await client.music.set(`${guildId}.autodj`, data);
    return cnt;
  },

  /** Get global stats (likes, dislikes, plays) for a track URL across all users in a guild */
  async getGlobalTrackStats(client, guildId, trackUrl, allPlaylists, guild = null) {
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
        // Comparación CANÓNICA: las variantes (`&list=`) del mismo video suman
        // sus likes/dislikes/plays como UNA sola canción.
        if (this.canonUrlKey(t.url) === this.canonUrlKey(trackUrl)) {
          plays += (t.playCount || 0);
          // Solo una favorita REAL (con 👍 o guardada a mano ⭐) cuenta como
          // "dueña" del tema. Antes aparecía como 👤 cualquiera que tuviera la
          // canción en Favoritas, incluso la basura que una versión vieja del
          // bot guardaba sola al reproducirse (faz pensaba que otros le dieron
          // like cuando era puro autoguardado).
          if (this.isRealFavorite(t)) {
            // CONTEO ACUMULADO (por reproducción): se suman todos los 👍/👎,
            // incluidos los repetidos del mismo usuario en distintas
            // reproducciones (mismo criterio que el botón y listGuildFavorites).
            for (const uid of (t.likedBy || [])) likedByIds.push(uid);
            for (const uid of (t.dislikedBy || [])) dislikedByIds.push(uid);
            pushUnique(ownerIds, userId);
          }
          break;
        }
      }
    }
    // Sum the persistent guild stats too (survive favorites removal). Los likes/
    // dislikes del store de guild están DEDUPLICADOS (máx 1 por usuario) y las
    // favoritas ya traen el conteo acumulado: NO sumarlos o se duplicarían.
    const gStat = (await this.guildStats(client, guildId))[trackUrl];
    if (gStat) {
      plays = Math.max(plays, gStat.plays || 0);
      // El store global está DEDUPLICADO (1 por usuario) y las favoritas traen
      // el acumulado, así que no se suman tal cual o se duplicarían. Pero antes
      // solo se usaban si las favoritas no tenían NADA (`if (!likedByIds.length)`):
      // un 👍 que quedó solo en gStat (escritura en carrera) se perdía en
      // pantalla en cuanto la lista tenía un solo elemento, y el contador "daba
      // un paso atrás" al primer click. Ahora se suman SOLO los usuarios que no
      // estén ya representados en las favoritas.
      const yaLiked = new Set(likedByIds);
      for (const uid of gStat.likedBy || []) if (!yaLiked.has(uid)) likedByIds.push(uid);
      const yaDisliked = new Set(dislikedByIds);
      for (const uid of gStat.dislikedBy || []) if (!yaDisliked.has(uid)) dislikedByIds.push(uid);
    }
    const resolveNames = (ids) => Promise.all(ids.map((id) => _resolveName(client, guild, id)));
    likedNames.push(...await resolveNames(likedByIds));
    dislikedNames.push(...await resolveNames(dislikedByIds));
    // El CONTEO queda acumulado (todos los 👍/👎); los nombres se deduplican
    // para no mostrar "dani_sas, dani_sas" cuando el mismo usuario likeó varias
    // reproducciones de la misma canción.
    return {
      likes: likedByIds.length,
      dislikes: dislikedByIds.length,
      plays,
      likedBy: [...new Set(likedNames)],
      dislikedBy: [...new Set(dislikedNames)],
      owners: await resolveNames(ownerIds),
    };
  },

  /** Increment play count for a track by URL (called when it actually starts playing). Returns true if found */
  async countPlay(client, guildId, userId, name, trackUrl) {
    const key = `${guildId}.playlists.${userId}`;
    const all = await this.getAll(client, guildId, userId);
    const list = all[name] || [];
    // Match por clave canónica: las reproducciones de las variantes del mismo
    // video se suman a la MISMA entrada de favoritas.
    let track = this.findTrackByCanon(list, trackUrl);
    if (!track) track = list.find((t) => t.url === trackUrl);
    if (!track) return false;
    track.playCount = typeof track.playCount === "number" && track.playCount > 0 ? track.playCount + 1 : 1;
    all[name] = list;
    await Promise.all([
      client.music.set(key, all),
      this.trackPlay(client, guildId, trackUrl),
    ]);
    client.logger?.log(
      `[Stats] 🎵 +1 reproducción "${track.name || trackUrl}" (G:${guildId}, user:${userId}) → total ${track.playCount}`
    );
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

// ══ Serialización de mutaciones sobre el árbol de playlists del gremio ══
// Se envuelven TODOS los métodos que leen→mutan→escriben el árbol de playlists
// (+ los snapshots de lectura para que vean el estado confirmado) para que el
// get y el set de cada operación queden dentro del MISMO turno del lock por
// gremio. Sin esto, `countPlay` podía leer la lista antes del set del 👍 y su
// set posterior pisaba el likedBy (el like quedaba solo en gStat, y el log de
// diagnóstico mostraba `fav.likedBy=0` con `gStat.likedBy=1`).
const _LOCKED_METHODS = new Set([
  "create",
  "addTracks",
  "removeTrack",
  "removeTracks",
  "clearExcept",
  "clearAll",
  "clearGuildFavorites",
  "likeTrackByUrl",
  "likeForUser",
  "dislikeTrackByUrl",
  "sortFavorites",
  "rename",
  "delete",
  "countUnlikedFavorites",
  "verifyLike",
  "listGuildFavorites",
  "pruneUnlikedFavorites",
  "pruneUnlikedFavoritesForUser",
  "countPlay",
  // ── Todo lo que escribe `${guildId}.autodj` ────────────────────────────────
  // Cada uno hace get→mutar→set del documento ENTERO del guild. Sin el lock, un
  // skip (o el refill escribiendo "seen") concurrente con otro writer se pisa y
  // se pierden skips / historial / patrón. Son las funciones EXTERNAS: las
  // primitivas getAutoDjState/saveAutoDjState quedan FUERA del lock a propósito
  // (meterlas causaría deadlock, porque se llaman entre sí).
  "recordTrackSkip",
  "addAutodjExclude",
  "addAutoDjPick",
  "removeAutoDjPick",
  "setAutoDjPattern",
  "saveAutoDjSeen",
]);
for (const name of _LOCKED_METHODS) {
  const orig = module.exports[name];
  if (typeof orig !== "function") continue;
  const bound = orig.bind(module.exports);
  module.exports[name] = async function (...args) {
    const guildId = args[1];
    return _runGuildLocked(guildId, () => bound(...args));
  };
}
