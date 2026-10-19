const MAX_REQUESTS_PER_USER = 300;
const MAX_ARTISTS_PER_USER = 60;

function canonKey(url) {
  if (typeof url !== "string" || !url) return url;
  try {
    const nu = new URL(url.trim());
    if (/youtube\.com|youtu\.be/i.test(nu.host || "")) {
      const v = nu.searchParams.get("v");
      if (v) return `yt:${v}`;
      if (nu.pathname.startsWith("/shorts/")) return `yt:${nu.pathname.split("/")[2] || url}`;
    }
  } catch {}
  return url.trim();
}

function artistOf(song) {
  const raw =
    (song && (song.uploader?.name || song.uploader || song.artist)) || null;
  if (!raw || typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > 80) return null;
  return name;
}

module.exports = {
  canonKey,
  artistOf,

  /** Registra una canción pedida por un usuario (al sonar). Dedupe por URL. */
  async recordRequest(client, guildId, userId, song) {
    if (!client?.music || !guildId || !userId || !song?.url) return null;
    const key = `${guildId}.userRequests.${userId}`;
    const list = (await client.music.get(key).catch(() => null)) || [];
    const ck = canonKey(song.url);
    const existing = list.find((r) => canonKey(r.url) === ck);
    const artist = artistOf(song);
    if (existing) {
      existing.plays = (Number(existing.plays) || 0) + 1;
      existing.lastPlayedAt = Date.now();
      if (artist && !existing.artist) existing.artist = artist;
    } else {
      list.unshift({
        url: song.url,
        name: song.name || song.title || null,
        artist,
        duration: Math.round(Number(song.duration) || 0),
        thumbnail: song.thumbnail || null,
        source: song.source || null,
        requestedAt: Date.now(),
        lastPlayedAt: Date.now(),
        plays: 1,
      });
      if (list.length > MAX_REQUESTS_PER_USER) list.length = MAX_REQUESTS_PER_USER;
    }
    await client.music.set(key, list).catch(() => {});
    if (artist) await this.bumpArtist(client, guildId, userId, artist);
    return existing || list[0];
  },

  /** Suma 1 al contador de un artista detectado para ese usuario. */
  async bumpArtist(client, guildId, userId, artist) {
    if (!client?.music || !guildId || !userId || !artist) return;
    const key = `${guildId}.userArtists.${userId}`;
    const map = (await client.music.get(key).catch(() => null)) || {};
    const k = String(artist).trim().toLowerCase();
    if (!k) return;
    map[k] = map[k] || { name: String(artist).trim(), count: 0 };
    map[k].count = (Number(map[k].count) || 0) + 1;
    const keys = Object.keys(map);
    if (keys.length > MAX_ARTISTS_PER_USER) {
      keys.sort((a, b) => (map[b].count || 0) - (map[a].count || 0));
      for (const kk of keys.slice(MAX_ARTISTS_PER_USER)) delete map[kk];
    }
    await client.music.set(key, map).catch(() => {});
  },

  /** Canciones pedidas por un usuario. */
  async getUserRequests(client, guildId, userId) {
    if (!client?.music || !guildId || !userId) return [];
    return (await client.music.get(`${guildId}.userRequests.${userId}`).catch(() => null)) || [];
  },

  /** Artistas detectados de un usuario: [{name, count}] ordenados por uso. */
  async getUserArtists(client, guildId, userId) {
    if (!client?.music || !guildId || !userId) return [];
    const map = (await client.music.get(`${guildId}.userArtists.${userId}`).catch(() => null)) || {};
    return Object.values(map)
      .filter((a) => a && a.name)
      .sort((a, b) => (b.count || 0) - (a.count || 0));
  },

  /** Agrupa las canciones pedidas de todos los usuarios del guild. */
  async listGuildUserRequests(client, guildId) {
    if (!client?.music || !guildId) return {};
    const root = (await client.music.get(guildId).catch(() => null)) || {};
    const ur = root.userRequests || {};
    const out = {};
    for (const [uid, list] of Object.entries(ur)) {
      if (Array.isArray(list) && list.length) out[uid] = list;
    }
    return out;
  },

  /** Agrupa los artistas detectados de todos los usuarios del guild. */
  async listGuildUserArtists(client, guildId) {
    if (!client?.music || !guildId) return {};
    const root = (await client.music.get(guildId).catch(() => null)) || {};
    const ua = root.userArtists || {};
    const out = {};
    for (const [uid, map] of Object.entries(ua)) {
      const arr = Object.values(map || {}).filter((a) => a && a.name);
      if (arr.length) out[uid] = arr.sort((a, b) => (b.count || 0) - (a.count || 0));
    }
    return out;
  },

  /** Alta manual (dashboard): agrega una canción pedida por un usuario. */
  async addManualRequest(client, guildId, userId, track) {
    if (!client?.music || !guildId || !userId || !track?.url) return null;
    const key = `${guildId}.userRequests.${userId}`;
    const list = (await client.music.get(key).catch(() => null)) || [];
    const ck = canonKey(track.url);
    const existing = list.find((r) => canonKey(r.url) === ck);
    if (existing) return existing;
    const entry = {
      url: track.url,
      name: track.name || track.title || null,
      artist: track.artist || null,
      duration: Math.round(Number(track.duration) || 0),
      thumbnail: track.thumbnail || null,
      source: track.source || null,
      requestedAt: Date.now(),
      lastPlayedAt: null,
      plays: 0,
      manual: true,
    };
    list.unshift(entry);
    if (list.length > MAX_REQUESTS_PER_USER) list.length = MAX_REQUESTS_PER_USER;
    await client.music.set(key, list).catch(() => {});
    return entry;
  },

  /** Baja manual (dashboard): quita una canción pedida por un usuario. */
  async removeManualRequest(client, guildId, userId, url) {
    if (!client?.music || !guildId || !userId || !url) return false;
    const key = `${guildId}.userRequests.${userId}`;
    const list = (await client.music.get(key).catch(() => null)) || [];
    const ck = canonKey(url);
    const idx = list.findIndex((r) => canonKey(r.url) === ck);
    if (idx === -1) return false;
    list.splice(idx, 1);
    await client.music.set(key, list).catch(() => {});
    return true;
  },

  /** Edita nombre/artista de una canción pedida (dashboard). */
  async updateManualRequest(client, guildId, userId, url, fields) {
    if (!client?.music || !guildId || !userId || !url) return null;
    const key = `${guildId}.userRequests.${userId}`;
    const list = (await client.music.get(key).catch(() => null)) || [];
    const ck = canonKey(url);
    const entry = list.find((r) => canonKey(r.url) === ck);
    if (!entry) return null;
    if (fields.name !== undefined) entry.name = fields.name || null;
    if (fields.artist !== undefined) entry.artist = fields.artist || null;
    if (fields.duration !== undefined) entry.duration = Math.round(Number(fields.duration) || 0);
    if (fields.thumbnail !== undefined) entry.thumbnail = fields.thumbnail || null;
    await client.music.set(key, list).catch(() => {});
    return entry;
  },

  /** Vacía las canciones pedidas de un usuario. */
  async clearUserRequests(client, guildId, userId) {
    if (!client?.music || !guildId || !userId) return 0;
    const key = `${guildId}.userRequests.${userId}`;
    const list = (await client.music.get(key).catch(() => null)) || [];
    await client.music.set(key, []).catch(() => {});
    return list.length;
  },

  /**
   * (Primer arranque) Carga en userRequests/userArtists las "Canciones
   * Favoritas" de cada usuario para que el dashboard tenga qué mostrar y el
   * AutoDJ/artistas tengan datos desde el minuto uno. Idempotente (dedupe por
   * URL canónica) y reversible (clearUserRequests).
   */
  async seedFromFavorites(client, guildId, PlaylistStore) {
    const out = { users: 0, requests: 0, skipped: 0 };
    if (!client?.music || !guildId || !PlaylistStore) return out;
    const songs = await PlaylistStore.listGuildFavorites(client, guildId, 3000).catch(() => []);
    if (!Array.isArray(songs) || !songs.length) return out;
    const secs = (d) => {
      if (typeof d === "number" && Number.isFinite(d)) return Math.round(d);
      const m = /^(\d+):(\d{1,2})$/.exec(String(d || "").trim());
      if (m) return Number(m[1]) * 60 + Number(m[2]);
      return 0;
    };
    const byUser = {};
    for (const s of songs) {
      const uid = String(s.userId || "");
      if (!uid || !s.url) continue;
      (byUser[uid] = byUser[uid] || []).push(s);
    }
    for (const [uid, list] of Object.entries(byUser)) {
      for (const s of list) {
        const added = await this.addManualRequest(client, guildId, uid, {
          url: s.url,
          name: s.name || null,
          artist: s.uploader || null,
          duration: secs(s.duration),
          thumbnail: s.thumbnail || null,
          source: null,
        });
        if (added) out.requests++;
        else out.skipped++;
        if (s.uploader) await this.bumpArtist(client, guildId, uid, s.uploader).catch(() => {});
      }
      out.users++;
    }
    return out;
  },
};
