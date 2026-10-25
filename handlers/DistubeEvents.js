const { EmbedBuilder, Events } = require("discord.js");
const { entersState, VoiceConnectionStatus } = require("@discordjs/voice");
const MusicBot = require("./Client");
const AutoresumeHandler = require("./AutoresumeHandler");
const InitAutoResume = require("./InitAutoresume");
const UserHistory = require("./UserHistory");
const MusicTracker = require("./MusicTracker");
const UserRequests = require("./UserRequests");
const PlaylistStore = require("./PlaylistStore");
const AutoDjSource = require("./Autodjsource");
const AutoDjLogger = require("./AutoDjLogger");
const AutoDjOrder = require("./AutoDjOrder");
const { fetchPlaylistFirstURL, probeSingleURL, validateSinglePlayable, isPlaylistURL, searchYoutubeVideos } = require("./PlaylistFetcher");
const { isAgeGateError, friendlyPlaybackError } = require("./PlaybackError");
const { startMarqueeActivity, stopMarqueeActivity } = require("./ActivityManager");

const MAX_SESSION_SONGS = 150;

// ── Búsqueda en YouTube al vuelo (paso 🎤 Artistas del perfil) ──────────────
// Cuando el server no tiene canciones guardadas de los artistas TOP del perfil
// (ej. milo j, kidd voodoo), se buscan en YouTube en el momento y se elige una
// NUEVA (que el usuario no tenga en su historial/cola). Cache corto para no
// martillar la API de YouTube ni resolver la misma búsqueda en cada refill.
const _artistSearchCache = new Map(); // query -> { at, results:[{url,name,uploader,duration}] }
const ARTIST_SEARCH_TTL = Math.max(
  60000,
  Number(process.env.AUTODJ_ARTIST_SEARCH_TTL) || 10 * 60 * 1000
);
const ARTIST_SEARCH_LIMIT = Math.max(
  3,
  Math.min(15, Number(process.env.AUTODJ_ARTIST_SEARCH_LIMIT) || 8)
);

async function searchArtistSongs(client, query, limit = ARTIST_SEARCH_LIMIT) {
  if (!query) return [];
  const key = String(query).trim().toLowerCase();
  const hit = _artistSearchCache.get(key);
  if (hit && (Date.now() - hit.at) < ARTIST_SEARCH_TTL) return hit.results;
  try {
    const raw = await searchYoutubeVideos(String(query).trim(), limit);
    const results = (Array.isArray(raw) ? raw : [])
      .map((s) => ({
        url: s?.url || null,
        name: s?.name || null,
        uploader: s?.uploader ? { name: String(s.uploader) } : null,
        duration: Number(s?.duration) || 0,
      }))
      .filter((s) => s.url);
    _artistSearchCache.set(key, { at: Date.now(), results });
    client?.logger?.log?.(`[AutoDJ] 🔎 artistas "${query}" → ${results.length} resultados`);
    return results;
  } catch (err) {
    client?.logger?.log?.(`[AutoDJ] búsqueda artistas falló ("${query}"): ${err?.message || err}`);
    _artistSearchCache.set(key, { at: Date.now(), results: [] });
    return [];
  }
}

const isOtherRequester = (user, ownerId) => !!(ownerId && user?.id && user.id !== ownerId);

// Clave canónica de una URL: así las exclusiones del AutoDJ atrapan la misma
// canción aunque esté guardada con variantes (&list=, index, mayúsculas, etc.).
// El botón 🚫 banea la url "limpia" que sonó, pero el pool de recomendación
// puede tener la variante de su lista original → antes no coincidían y el tema
// volvía a recomendarse a pesar del 🚫.
const canonUrlKey = (u) => {
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
};

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
   * Auto DJ: intercala canciones del bot EN MEDIO de la lista mientras dure.
   *
   * El AutoDJ NO toca la cola que puso el usuario (se respeta el orden): solo
   * suma canciones y las inserta intercaladas (posición 1, 3, 5…). El patrón
   * por defecto es SOLO 🛸 recomendaciones (la lista ya suele venir mezclada
   * con el botón 🔀); quien quiera 🎲 aleatorias configura el patrón.
   * Las candidatas son SOLO canciones que les gustan (👍) a los que están en
   * el voice, o guardadas a mano con ⭐; con patrón configurable:
   *   rec usuario X → "🛸 <X>" (elegida al azar de las favoritas reales de X)
   *   random        → "🎲 Aleatoria" (de TODA la lista que se está reproduciendo)
   * Nunca se repite lo que ya se puso, ni en la sesión ni entre sesiones
   * (historial persistente por guild). Si el pool se agota, se olvida lo más
   * viejo (menos lo que está en cola) para que el AutoDJ no muera.
   *
   * @param {object} queue - cola de DisTube
   * @param {object} [opts]
   * @param {object} [opts.channel] - canal de voz (seed inicial)
   * @param {boolean} [opts.force]  - fuerza el reabastecimiento aunque queden canciones
   * @returns {Promise<number>} - cantidad de canciones añadidas
   */
  client.autoDjRefill = async function _autoDjRefill(autodjTaskQueue, autodjTaskOpts = {}) {
    const _gid = autodjTaskQueue?.textChannel?.guildId || autodjTaskQueue?.guildId;
    if (!_gid) return 0;
    client.autoDjBusy = client.autoDjBusy || new Map();
    const lock = client.autoDjBusy.get(_gid);
    // El lock guarda el timestamp: si un refill quedó colgado (p.ej. un play() que
    // nunca resuelve) se libera solo en vez de dejar el AutoDJ muerto para siempre.
    client.autoDjPendingForce = client.autoDjPendingForce || new Map();
    if (lock) {
      if (Date.now() - lock < 120000) {
        // Antes el refill "forzado" (al activar el AutoDJ) se perdía en silencio
        // si justo había otro corriendo. Ahora queda pendiente y se corre al terminar.
        if (autodjTaskOpts.force) client.autoDjPendingForce.set(_gid, autodjTaskOpts);
        return 0;
      }
      client.logger.warn(`[AutoDJ] Guild ${_gid}: refill colgado hace ${Math.round((Date.now() - lock) / 1000)}s, se reanuda.`);
      client.autoDjBusy.delete(_gid);
    }
    client.autoDjBusy.set(_gid, Date.now());
    let added = 0;
    try {
      added = await client.autoDjRefillInner(autodjTaskQueue, autodjTaskOpts);
    } catch (e) {
      client.logger.error(`[AutoDJ] Refill error:`, e);
    } finally {
      client.autoDjBusy.delete(_gid);
    }
    const pend = client.autoDjPendingForce.get(_gid);
    if (pend) {
      client.autoDjPendingForce.delete(_gid);
      const qLive = client.distube.getQueue(_gid) || autodjTaskQueue;
      added += await client.autoDjRefill(qLive, pend);
    }
    return added;
  };

  // Set ACOTADO (Map con orden de inserción) de lo ya reproducido/encolado por
  // el AutoDJ. Se siembra con el historial persistente del guild (para no
  // repetir entre sesiones) y se acota para no crecer sin límite.
  const SEEN_MAX = 400;
  const seenOf = (queue) => {
    if (!(queue._autoDjSeen instanceof Map)) queue._autoDjSeen = new Map();
    return queue._autoDjSeen;
  };
  const seenMark = (seen, url) => { if (url) seen.set(url, Date.now()); };
  // Olvida lo más viejo, pero NUNCA lo que está en cola ahora mismo (si no, el
  // AutoDJ metería dos veces la misma canción).
  const seenTrim = (seen, inQueue) => {
    if (seen.size <= SEEN_MAX) return;
    let drop = seen.size - SEEN_MAX;
    for (const k of [...seen.keys()]) {
      if (drop <= 0) break;
      if (inQueue?.has(k)) continue;
      seen.delete(k);
      drop--;
    }
  };
  /**
   * Elige una favorita que aún no se haya puesto. Si ya se agotaron TODAS las
   * candidatas, olvida la mitad más vieja de "lo visto" (menos lo que está en
   * cola) para que las favoritas vuelvan a entrar en rotación.
   */
  const REC_MIN_GAP = 5; // 🛸 no recomienda lo que va a sonar en los próximos ~5 temas
  const REC_HISTORY_MAX = 25; // máximo de canciones del historial de cada oyente que entran al pool de 🛸

  // Umbrales del watchdog de cola (ms de player idle antes de actuar).
  //
  // El 1º escalón estaba en 20s y eso era MUY agresivo para este bot: yt-dlp
  // tarda 22-47s en resolver (los timeouts de validateSinglePlayable son de
  // 22s y los agregados del AutoDJ tardaron 39s y 47s). Una transición normal
  // pero lenta se marcaba como "colgada", el watchdog reintentaba y terminaba
  // saltando una canción que igual iba a sonar. 45s deja margen de sobra para
  // una transición legítima sin dejar al bot mudo.
  const STALL_1ST_MS = 45000;
  const STALL_2ND_MS = 30000;

  // Margen que se espera tras drenar la cola de tareas antes de decidir si hay
  // que saltar. Drenar suelta la promesa de la operación de DisTube, pero esa
  // continuación corre como microtask/tarea posterior: songs[0] todavía NO
  // refleja el avance en el instante inmediato. Sin esta espera, la guarda
  // vería la canción vieja, daría el salto y la transición liberada por el
  // drenaje avanzaría la cola por su cuenta = salto doble (canción perdida).
  const STALL_DRAIN_GRACE_MS = 3000;

  /**
   * Elige una favorita que aún no se haya puesto. Si ya se agotaron TODAS las
   * candidatas, olvida la mitad más vieja de "lo visto" (menos lo que está en
   * cola) para que las favoritas vuelvan a entrar en rotación.
   * `blocked` = urls que NO podemos usar ahora (ya en la cola y próximas a
   * sonar / la que está sonando). Las favoritas en `blocked` no se tocan; las
   * que están en la cola pero LEJOS se pueden usar: luego se "adelantan" al
   * hueco del AutoDJ sin duplicarse (el loader salta las usadas).
   *
   * `weightOf` (opcional) = peso de cada candidata; respeta los skips.
   *
   * IMPORTANTE: se.sortea de verdad. Antes devolvía `usable.find(...)` y, si no
   * quedaba ninguna sin ver, `usable[0]`: ambos son el PRIMERO de la lista, así
   * que el bot tendía a repetir siempre las mismas 2-3 canciones, por muy
   * grande que fuera la lista. Con un pool chico (19 reales) se oía clarísimo.
   */
  /**
   * Streams que mueren nada mas arrancar (el oyente oye 2s y la cancion se
   * salta sola). No son un problema del AutoDJ sino del stream: la pista se
   * reintenta 2 veces y al fallar vuelve a colarse en el pool, con lo que el
   * fallo se repite cada poco. Se marcan como "muertos" un buen rato para que
   * no vuelvan a salir.
   */
  const STREAM_DEAD_TTL = 12 * 60 * 60 * 1000; // 12h
  const deadKey = (url) => canonUrlKey(url);

  const isStreamDead = (url) => {
    if (!url) return false;
    const map = client._streamDead;
    if (!map) return false;
    const until = map.get(deadKey(url));
    if (!until) return false;
    if (Date.now() > until) {
      map.delete(deadKey(url));
      return false;
    }
    return true;
  };

  // Suma un fallo al contador del stream y, si insiste, lo aparta un buen rato.
  const noteStreamFailure = (url) => {
    if (!url) return false;
    if (!client._streamFails) client._streamFails = new Map();
    if (!client._streamDead) client._streamDead = new Map();
    const k = deadKey(url);
    const prev = client._streamFails.get(k)?.ts || 0;
    const n = (Date.now() - prev < 60 * 60 * 1000 ? (client._streamFails.get(k)?.n || 0) : 0) + 1;
    client._streamFails.set(k, { n, ts: Date.now() });
    if (n >= 3) {
      client._streamDead.set(k, Date.now() + STREAM_DEAD_TTL);
      client._streamFails.delete(k);
      return true;
    }
    return false;
  };

  // Sorteo proporcional a los pesos (respeta los skips del grupo).
  const weightedPick = (arr, weightOf) => {
    if (!arr.length) return null;
    if (!weightOf) return arr[Math.floor(Math.random() * arr.length)];
    let total = 0;
    const ws = arr.map((t) => { const w = Math.max(0.01, Number(weightOf(t)) || 0.01); total += w; return w; });
    let r = Math.random() * total;
    for (let i = 0; i < arr.length; i++) { r -= ws[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  };

  // Elige priorizando las que MENOS se han reproducido.
  //
  // El problema que había: el sorteo era uniforme sobre TODAS las candidatas,
  // así que una canción con 40 reproducciones tenía la misma probabilidad que
  // una que nunca sonó. Con pools chicos (mediana de 37 en los logs, y 83 de
  // 175 selecciones con pool <=20) eso se traducía en la misma canción cada
  // rato: el peor caso del log seleccionó el mismo video 20 veces seguidas con
  // pool=12 y 10 de 12 ya descartadas por historia.
  //
  // Ahora se ordena por `playCount` y se sortea SOLO dentro del escalón más
  // bajo. El escalón cubre un 25% de las candidatas para que no sea un ciclo
  // determinista y se mantenga la variedad. Dentro del escalón se sigue pesando
  // por skips, así una canción que la gente salta sigue bajando.
  const playsOf = (t) => Math.max(0, Number(t?.playCount) || 0);
  const pickLeastPlayed = (arr, weightOf, playsOfFn = playsOf) => {
    if (!arr?.length) return null;
    const plays = arr.map(playsOfFn);
    const min = Math.min(...plays);
    const max = Math.max(...plays);
    // Todas igual de reproducidas: el escalón no aporta nada, no lo limito.
    if (max === min) return weightedPick(arr, weightOf);
    const sorted = arr.slice().sort((a, b) => playsOfFn(a) - playsOfFn(b));
    const tier = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.25)));
    return weightedPick(tier, weightOf);
  };

  const likesOf = (t) => Math.max(0, (t?.likedBy || []).length - (t?.dislikedBy || []).length);
  const pickMostLiked = (arr, weightOf) => {
    if (!arr?.length) return null;
    const scores = arr.map(likesOf);
    const max = Math.max(...scores);
    if (max <= 0) return weightedPick(arr, weightOf);
    const sorted = arr.slice().sort((a, b) => likesOf(b) - likesOf(a) || playsOf(a) - playsOf(b));
    const tier = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.3)));
    return weightedPick(tier, weightOf);
  };

  const pickUnseen = (pool, seen, excluded, blocked, weightOf = null) => {
    const usable = pool.filter((t) => {
      if (!t?.url) return false;
      if (excluded && excluded.size && excluded.has(canonUrlKey(t.url))) return false;
      if (blocked?.has?.(t.url)) return false;
      // Stream muerto al arrancar: no se vuelve a sortear (evita el ciclo
      // "suena 2s y se salta" que se repetia cada poco).
      if (isStreamDead(t.url)) return false;
      return true;
    });
    if (!usable.length) return null;
    const pickFrom = (arr) => pickLeastPlayed(arr, weightOf);
    const fresh = usable.filter((t) => !seen.has(t.url));
    if (fresh.length) return pickFrom(fresh);
    // Todo visto: se olvida la mitad MÁS VIEJA de lo visto y se recicla de ahí.
    let drop = Math.max(1, Math.floor(seen.size / 2));
    for (const k of [...seen.keys()]) {
      if (drop <= 0) break;
      if (blocked.has(k)) continue;
      seen.delete(k);
      drop--;
    }
    const recycled = usable.filter((t) => !seen.has(t.url));
    return pickFrom(recycled.length ? recycled : usable);
  };

  // ── Marca de "canción del AutoDJ" + orden de la cola ──────────────────────
  // Se marca EN EL MOMENTO en que la canción entra a la cola (evento addSong), no
  // al final del refill (que tarda ~10 s por canción). Antes, durante esos minutos
  // las canciones del bot parecían pedidos manuales del oyente y, peor, el
  // "Queue Priority" las trataba como pedidos de otra persona y las mandaba al frente.
  const flagBotSong = (queue, song, meta, added) => {
    if (!song || !meta) return;
    song.autoDj = true;
    song._autoDj = true;
    song.autoDjType = meta.type;
    song.autoDjUserId = meta.userId || null;
    song.autoDjFallback = meta.fallback || null;
    // `_autoDjAdded`: la ENCOLÓ el bot (no era de la lista de nadie).
    if (added) song._autoDjAdded = true;
    if (!Number.isFinite(song._autoDjSeq)) {
      const base = Math.max(Number(queue._autoDjSeqCounter) || 0, Number(meta.seq) || 0);
      if (Number.isFinite(meta.seq)) {
        song._autoDjSeq = meta.seq;
        queue._autoDjSeqCounter = base;
      } else {
        queue._autoDjSeqCounter = base + 1;
        song._autoDjSeq = queue._autoDjSeqCounter;
      }
    }
  };

  // Registra "esta URL la va a poner el bot" mientras dura el play(): el handler de
  // addSong la reconoce al instante.
  const enqueueBot = async (queue, url, meta, fn) => {
    const gid = queue.textChannel?.guildId || queue.guildId;
    const key = `${gid}|${canonUrlKey(url)}`;
    const map = client._autoDjPending || (client._autoDjPending = new Map());
    map.set(key, meta);
    try { return await fn(); } finally { map.delete(key); }
  };

  // Ordena la cola: [actual] + [pedidos de otras personas (prioridad de siempre)] +
  // el tramo del bot en ORDEN DE ELECCIÓN (_autoDjSeq = el ciclo) intercalado con las
  // canciones de la lista. Es idempotente: se puede llamar después de cada addSong.
  const relayoutQueue = (q) => {
    if (!q?.songs?.length) return;
    const isBot = (x) => !!(x && (x.autoDj || x._autoDj));
    if (!q.songs.some((x, i) => i > 0 && isBot(x))) return;
    const lay = q._autoDjLayout || { frontMix: true, frontCycle: 4, gap: 2 };
    const ownerId = process.env.OWNER_ID;
    const cur = q.songs[0] || null;
    const rest = q.songs.slice(1);
    const head = [];
    let k = 0;
    while (k < rest.length && !isBot(rest[k]) && isOtherRequester(rest[k]?.user, ownerId)) head.push(rest[k++]);
    const tail = rest.slice(k);
    const userSongs = tail.filter((x) => !isBot(x));
    const botSongs = tail.filter(isBot).sort((a, b) => (Number(a._autoDjSeq) || 0) - (Number(b._autoDjSeq) || 0));
    const rebuilt = cur ? [cur, ...head] : [...head];
    const base = rebuilt.length;
    let bi = 0;
    let ui = 0;
    while (bi < botSongs.length || ui < userSongs.length) {
      const rel = rebuilt.length - base + 1; // 1 = primera después de la actual (y los pedidos)
      const isFront = lay.frontMix && rel <= lay.frontCycle;
      const botSlot = isFront || (((rel - lay.frontCycle - 1) % lay.gap) === 0);
      if (botSlot && bi < botSongs.length) { rebuilt.push(botSongs[bi++]); continue; }
      if (ui < userSongs.length) { rebuilt.push(userSongs[ui++]); continue; }
      if (bi < botSongs.length) { rebuilt.push(botSongs[bi++]); continue; }
      break;
    }
    const seenUrl = new Set();
    const finalList = rebuilt.filter((x) => {
      if (!x?.url) return true;
      if (seenUrl.has(x.url)) return false;
      seenUrl.add(x.url);
      return true;
    });
    q.songs.splice(0, q.songs.length, ...finalList);
  };

  client.autoDjRefillInner = async (queue, { channel, force = false } = {}) => {
    const guildId = queue.textChannel?.guildId || queue.guildId;
    if (!guildId || !client.autoDj?.get(guildId) || !queue?.songs?.length) return 0;

    const vc = channel || queue.voice?.connection?.channel || queue.textChannel?.guild?.members?.me?.voice?.channel;
    if (!vc || !vc.members) return 0;
    const listeners = vc.members.filter((m) => !m.user.bot).map((m) => m.id);
    if (!listeners.length) return 0;
    // Un refill por cola a la vez (además del lock por guild de autoDjRefill).
    if (queue._autoDjRefilling) return 0;
    queue._autoDjRefilling = true;
    try {
      return await runAutoDjRefill(queue, { vc, guildId, listeners, force });
    } finally {
      queue._autoDjRefilling = false;
    }
  };

  // Resolución con tope de tiempo: un play() que se cuelga (lista gigante,
  // video caído que yt-dlp reintenta…) NO debe poder paralizar el refill ni la
  // transición de la cola. Si expira, se abandona esa candidata.
  const withTimeout = (p, ms, label) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout ${ms}ms ${label}`)), ms);
      p.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });

  // ---- AutoDJ: encolar SIN bloquear la "_taskQueue" de la cola ----
  // distube.play() hace esto:
  //     await queue._taskQueue.queuing(true)   <-- TOMA la cola
  //     await this.handler.resolve(url)        <-- yt-dlp: 3-15 s
  //     queue._taskQueue.resolve()             <-- la suelta recién ahí
  // La transición entre canciones (handleSongFinish) ESPERA esa misma cola,
  // así que el play() del AutoDJ la BLOQUEABA: de ahí los 16-36 s de silencio
  // entre tema y tema (y el watchdog saltando/reconectando).
  // Acá se RESUELVE el video FUERA de la cola y se le pasa a play() el Song ya
  // resuelto: handler.resolve() devuelve la instancia de Song al instante, así
  // que la cola se suelta en ~1 ms y la transición nunca queda pegada.
  const enqueueSong = async (client, vc, url, options) => {
    // Sin handler no se puede resolver por fuera: se cae al play() de siempre.
    if (typeof client.distube?.handler?.resolve !== "function") {
      return client.distube.play(vc, url, options);
    }
    const resolved = await withTimeout(
      client.distube.handler.resolve(url, { member: options?.member }),
      40000,
      `resolve ${url}`
    );
    if (!resolved || resolved.songs?.length || !resolved.url) {
      // Se resolvió como lista/set: nunca se mete una lista a la cola.
      throw new Error(`resolve_no_song ${url}`);
    }
    await withTimeout(
      client.distube.play(vc, resolved, options),
      20000,
      `play ${url}`
    );
    return resolved;
  };

  // ---- Validador de la siguiente canción ----
  // DisTube resuelve la canción siguiente con SU extractor al terminar la
  // actual; si esa resolución se cuelga (YouTube/throttle/age-gate), la
  // transición queda bloqueada y DisTube se serializa entero (el skip del
  // watchdog tampoco entra). Prevenirlo: mientras suena la actual, validamos
  // songs[1] con yt-dlp (con tope, matando el proceso si cuelga). Si no
  // valida, se SACA de la cola y se prueba la siguiente (máx 3). Así la
  // transición natural siempre cae en una canción ya comprobada.
  const _nextValidated = new Map(); // `${guild}|${url}` -> at
  const NEXT_VALIDATE_TTL = 10 * 60 * 1000;
  const scheduleNextValidation = (client, queue) => {
    try {
      const guildId = queue.textChannel?.guildId || queue.guildId;
      if (!guildId || !queue.songs?.length) return;
      if (queue._valNextBusy) return;
      const next = queue.songs[1];
      if (!next?.url) return;
      const key = `${guildId}|${next.url}`;
      const cache = _nextValidated.get(key);
      if (cache && Date.now() - cache < NEXT_VALIDATE_TTL) return;
      if (queue._valNextChecked === next.url) return;
      queue._valNextChecked = next.url;
      queue._valNextBusy = true;
      setTimeout(() => {
        (async () => {
          try {
            const lq = client.distube.getQueue(guildId) || queue;
            if (!lq || !lq.songs?.length) return;
            const removed = [];
            let probes = 0;
            while (probes < 3 && lq.songs.length > 1) {
              const target = lq.songs[1];
              if (!target?.url) break;
              // Canciones cortas no merecen gastar yt-dlp (hoy lento): se dejan pasar.
              if (target.duration && target.duration < 35) break;
              const currentUrl = lq.songs[0]?.url;
              const keptKey = `${guildId}|${target.url}`;
              // Veredicto, NO booleano: un timeout de yt-dlp (que hoy se demora
              // 20-45s por llamada) NO significa "canción inválida". Solo se
              // descarta si YouTube confirma remoto/privado/inexistente;
              // si quedó "unknown", la canción se CONSERVA (el bucle de antes
              // descartaba todas las válidas con el tope de 12s).
              const verdict = await validateSinglePlayable(target.url, 22000);
              if (lq.songs[0]?.url !== currentUrl) break; // la cola avanzó mientras tanto
              if (verdict?.status === "ok") { _nextValidated.set(keptKey, Date.now()); break; }
              if (verdict?.status === "invalid") {
                client.logger.warn(
                  `[NextValidator ${guildId}] "${target.name || target.url}" INVÁLIDA (${verdict.reason}). Se descarta para evitar que la transición se cuelgue.`
                );
                lq.songs.splice(1, 1);
                removed.push(target.url);
                probes++;
                continue;
              }
              // unknown: yt-dlp lento/cortado. No descartar y no seguir
              // martillando: la próxima canción se reintentará sola.
              client.logger.warn(
                `[NextValidator ${guildId}] "${target.name || target.url}" sin confirmar (${verdict?.reason || "sin veredicto"}): se MANTIENE en la cola.`
              );
              break;
            }
            if (removed.length) {
              // Que el refill del AutoDJ no la vuelva a meter en la sesión.
              if (!lq._autoDjExcludedSession) lq._autoDjExcludedSession = new Set();
              for (const u of removed) lq._autoDjExcludedSession.add(u);
              if (lq._autoDjSeen instanceof Map) {
                for (const u of removed) lq._autoDjSeen.set(u, Date.now());
              }
              client.updatequeue(lq).catch(() => {});
              client.updateplayer(lq).catch(() => {});
            }
          } catch (e) {
          } finally {
            queue._valNextBusy = false;
          }
        })();
      }, 1200);
    } catch (e) {}
  };

  // Restaura el resto de la cola en una cola nueva (el play() de la reconexión
  // crea una cola de 1 SOLA canción: sin esto se perdían las ~91 restantes).
  // Se re-encolan los objetos Song YA resueltos (sin re-extraer cada url).
  const restoreQueueSongs = async (guildId, savedSongs, excludedUrl) => {
    const nq = client.distube.getQueue(guildId);
    if (!nq || !savedSongs?.length) return 0;
    let restored = 0;
    for (const s of savedSongs) {
      if (!s?.url || s.url === excludedUrl) continue;
      if (nq.songs?.some((x) => x?.url === s.url)) continue;
      try { await nq.add(s); restored++; }
      catch {
        try { await nq.add(s.url); restored++; } catch {}
      }
    }
    return restored;
  };

  // Reconexión automática tras el escalón de 90s del watchdog: el destroy
  // corta el bloqueo del play() colgado y esto vuelve a unir el bot y a seguir
  // con una canción VALIDADA (yt-dlp). El usuario no se queda sin música.
  const resumeAfterUnstick = async (guildId, queue) => {
    try {
      await new Promise((r) => setTimeout(r, 2500));
      const lq = client.distube.getQueue(guildId) || queue;
      if (!lq || !lq.songs?.length) return;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      const vc = lq.voice?.channel || guild.members?.me?.voice?.channel;
      if (!vc || !vc.members) return;
      // Elegir de la parte delantera la 1ª canción que pase la validación
      // (máx 6 candidatas / 10s cada una; tope total ~60s, con proceso saneado).
      let pick = null;
      for (let idx = 1; idx <= Math.min(6, lq.songs.length - 1); idx++) {
        const s = lq.songs[idx];
        if (!s?.url) continue;
        const cache = _nextValidated.get(`${guildId}|${s.url}`);
        const ok = (cache && Date.now() - cache < NEXT_VALIDATE_TTL)
          ? true
          : (await validateSinglePlayable(s.url, 15000))?.status === "ok";
        if (ok) { pick = s; break; }
        client.logger.warn(`[QueueWatchdog ${guildId}] "${s.name || s.url}" no valida al reconectar: se omite.`);
      }
      if (!pick) pick = lq.songs[1] || lq.songs[0];
      if (!pick?.url) return;
      // Guardar el RESTO de la cola ANTES de reconectar: el play() crea una
      // cola NUEVA de 1 canción y sin esto se perdían las ~91 restantes.
      const restSongs = (lq.songs || []).filter((s) => s?.url && s.url !== pick.url);
      await client.distube.voices.join(vc).catch(() => {});
      const liveQ = client.distube.getQueue(guildId) || lq;
      if (liveQ?.voice?.connection && liveQ !== lq) {
        try { await liveQ.leave().catch(() => {}); } catch (e) {}
      }
      // Se pasa el objeto Song (ya resuelto, y con su stream.url si estaba warm):
      //   - con la URL, DisTube re-resuelve DENTRO del play (3-15 s) y la
      //     reconexión arranca en silencio;
      //   - `pick.user` es un User, NO un GuildMember -> DisTube tiraba
      //     INVALID_TYPE y la reconexión FALLABA EN SILENCIO (el .catch la
      //     tapaba y el bot se quedaba mudo).
      const pickIsSong = !!(pick && typeof pick === "object" && pick.stream && typeof pick.stream === "object");
      await withTimeout(
        client.distube.play(vc, pickIsSong ? pick : pick.url, {
          member: pickIsSong ? (pick.member || null) : null,
          textChannel: lq.textChannel,
          skip: true,
        }),
        45000,
        "reconexión tras PEG"
      ).catch(() => {});
      const restored = await restoreQueueSongs(guildId, restSongs, pick.url);
      if (restored > 0) {
        client.logger.log(
          `[QueueWatchdog ${guildId}] restauradas ${restored} de ${restSongs.length} canciones de la cola tras la reconexión.`
        );
      }
      client.logger.log(
        `[QueueWatchdog ${guildId}] reconectado automáticamente: reproduciendo "${pick.name || pick.url}".`
      );
    } catch (e) {
      client.logger.error(`[QueueWatchdog ${guildId}] error al reconectar: ${e.message}`);
    }
  };

  // ---- Watchdog de CONEXIÓN de voz -----------------------------------------
  // Si la conexión no vuelve a "ready", el audioPlayer se queda en `autopaused`
  // PARA SIEMPRE: nadie lo saca de ahí. DisTube solo reconecta desde el estado
  // `disconnected`, así que una conexión atascada en connecting/signalling
  // (típico tras un ShardResume, cuando se cae el WS de voz) no dispara nada y
  // el bot queda mudo indefinidamente, con la cola intacta y sin un solo log.
  // @discordjs/voice vuelve a `playing` solo cuando la conexión queda `ready`
  // (el player necesita una conexión "playable"), así que el arreglo es forzar
  // el rejoin y, si no alcanza, la reconexión completa (recoverVoice).
  const CONN_STALL_MS = 25000;
  const clearConnWatchdog = (guildId) => {
    if (!client._voiceConnTimers) return;
    const t = client._voiceConnTimers.get(guildId);
    if (t) clearTimeout(t);
    client._voiceConnTimers.delete(guildId);
  };
  const armConnWatchdog = (guildId, conn, queue) => {
    try {
      if (!conn || conn.state?.status === "ready") return;
      if (!client._voiceConnTimers) client._voiceConnTimers = new Map();
      clearConnWatchdog(guildId);
      // Backoff: si los rescates siguen fallando se insiste cada vez más
      // espaciado (pero NUNCA se deja de vigilar: sin esto el PEG es eterno).
      const fails = Math.min(6, Number(client._voiceRecoverFails?.get(guildId)) || 0);
      const t = setTimeout(() => {
        client._voiceConnTimers?.delete(guildId);
        if (conn.state?.status === "ready") return;
        recoverVoice(guildId, queue, `conexión de voz caída (${Math.round(CONN_STALL_MS / 1000)}s sin "ready")`);
      }, CONN_STALL_MS * (1 + fails));
      if (typeof t.unref === "function") t.unref();
      client._voiceConnTimers.set(guildId, t);
    } catch (e) {}
  };

  // Espera (con tope) a que la conexión de voz vuelva a "ready".
  const waitVoiceReady = async (conn, ms) => {
    if (!conn) return false;
    if (conn.state?.status === "ready") return true;
    try {
      await withTimeout(
        entersState(conn, VoiceConnectionStatus.Ready, ms),
        ms + 3000,
        "voice ready"
      );
    } catch {}
    return conn.state?.status === "ready";
  };

  // ---- Rescate de una conexión de voz MUERTA (el "pegado" infinito) --------
  // El player solo vuelve a `playing` si tiene una conexión "playable", y una
  // conexión que quedó atascada en connecting/signalling (típico tras un
  // ShardResume, cuando se cae el WS de voz) NO vuelve sola: DisTube solo
  // reconecta desde el estado `disconnected`, así que antes el bot se quedaba
  // mudo para siempre, con la cola intacta y sin un solo log. Escalera:
  //   1) esperar a que termine el handshake (muchas veces se recupera sola)
  //   2) connection.rejoin() → nuevo handshake con el mismo adapter
  //   3) resumeAfterUnstick(): destroy + rejoin completo, restaurando la cola
  const recoverVoice = async (guildId, queue, reason) => {
    if (!client._voiceRecovering) client._voiceRecovering = new Map();
    if (client._voiceRecovering.get(guildId)) return; // ya hay un rescate en curso
    client._voiceRecovering.set(guildId, Date.now());
    try {
      const lq = client.distube.getQueue(guildId) || queue;
      if (!lq || !lq.songs?.length) return;
      const guild = lq.textChannel?.guild || client.guilds.cache.get(guildId);
      const vc = lq.voice?.channel || guild?.members?.me?.voice?.channel;
      if (!vc) return;
      const conn = lq.voice?.connection;
      const cur = lq.songs[0];
      const st = () => conn?.state?.status || "sin conexión";
      client.logger.warn(
        `[VoiceWatchdog ${guildId}] ${reason}. Cola viva: ${lq.songs.length} canciones, ` +
        `sonando "${cur?.name || cur?.url || "?"}". Estado de la conexión: "${st()}".`
      );

      if (await waitVoiceReady(conn, 15000)) {
        client.logger.log(`[VoiceWatchdog ${guildId}] la conexión de voz se recuperó sola; el audio sigue con "${cur?.name || "?"}".`);
        return;
      }
      client.logger.warn(`[VoiceWatchdog ${guildId}] sigue en "${st()}": forzando rejoin de la conexión de voz.`);
      if (conn && conn.state?.status !== "destroyed") {
        try { conn.rejoin(); } catch (e) {
          client.logger.warn(`[VoiceWatchdog ${guildId}] rejoin falló: ${e?.message || e}`);
        }
      }
      if (await waitVoiceReady(conn, 20000)) {
        client.logger.log(`[VoiceWatchdog ${guildId}] reconectado con rejoin; retomando "${cur?.name || "?"}".`);
        return;
      }
      client.logger.error(
        `[VoiceWatchdog ${guildId}] el rejoin no alcanzó: la conexión quedó en "${st()}". ` +
        `Rehaciendo la conexión de voz y restaurando la cola.`
      );
      // Hay que DESTRUIR la conexión atascada: `voices.join` sobre la misma no
      // serviría, porque `Voice#channel` corta antes de recrearla (mismo
      // channelId) y `entersState` nunca llega a ver "ready". Al destruirla,
      // DisTube libera el Voice y el rejoin de abajo crea una conexión nueva.
      try { if (conn && conn.state?.status !== "destroyed") conn.destroy(); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      await resumeAfterUnstick(guildId, lq);
    } catch (e) {
      client.logger.error(`[VoiceWatchdog ${guildId}] error en el rescate de voz: ${e?.message || e}`);
    } finally {
      client._voiceRecovering.delete(guildId);
      const lq2 = client.distube.getQueue(guildId) || queue;
      const c2 = lq2?.voice?.connection;
      const st2 = c2?.state?.status;
      if (lq2?.songs?.length && st2 && st2 !== "ready" && st2 !== "destroyed") {
        // El rescate no funcionó: se cuenta el intento (para el backoff del
        // watchdog) y se vuelve a armar la vigilancia. Sin esto, un rescate
        // fallido dejaba la cola sin ningún watchdog armed y el "pegado"
        // volvía a ser infinito.
        if (!client._voiceRecoverFails) client._voiceRecoverFails = new Map();
        client._voiceRecoverFails.set(guildId, (Number(client._voiceRecoverFails.get(guildId)) || 0) + 1);
        armConnWatchdog(guildId, c2, lq2);
      } else if (client._voiceRecoverFails) {
        client._voiceRecoverFails.delete(guildId);
      }
    }
  };

  // DisTube resuelve como PLAYLIST cualquier URL con `list=` (incluso un
  // watch?v=X&list=Y) y espera por TODOS sus videos antes de tocar nada: es lo
  // que dejó el bot "pegado" minutos enteros con el AutoDJ activo. A los VIDEOS
  // (watch/embed/shorts/live) se les quita la parte `&list=`; las LISTAS puras
  // (/playlist?list=) se dejan intactas para aislarles su 1ª canción aparte.
  const cleanYtUrl = (u) => {
    if (typeof u !== "string" || !u) return u;
    try {
      const nu = new URL(u);
      if (
        (/(?:youtube\.com|youtu\.be)/i.test(nu.host || nu.hostname)) &&
        /(?:watch|embed|shorts|live)\/?/.test(nu.pathname) &&
        nu.searchParams.has("list")
      ) {
        nu.searchParams.delete("list");
        nu.searchParams.delete("index");
        return nu.toString();
      }
    } catch {}
    return u;
  };
  // Solo se le pasa a `distube.play()` un URL que resuelva RÁPIDO como canción
  // individual. Playlists de YouTube, sets de SoundCloud y cualquier otra cosa
  // que DisTube resuelva como LOTE se descarta (o se aísla su 1ª canción):
  // aunque el refill abandone un play() lento, DisTube lo sigue resolviendo en
  // el fondo y termina metiendo la lista entera igual (eso es lo que añadió 99
  // canciones de golpe y "saltó 3" en los logs).
  const isSafeSingle = (u) => {
    if (typeof u !== "string" || !u || u.length < 8) return false;
    if (/[\?&#]list=/.test(u)) return false;
    if (/youtu\.be\/[A-Za-z0-9_-]{6,}/i.test(u)) return true;
    if (/youtube\.com\/(?:watch|embed|shorts|live)(?:[?#/]|$)/i.test(u)) return true;
    if (/music\.youtube\.com\/watch/i.test(u)) return true;
    if (/soundcloud\.com\//i.test(u) && !/\/sets\//i.test(u)) return true;
    if (/\.(mp3|m4a|ogg|wav|flac|webm|mp4)([?#].*)?$/i.test(u)) return true;
    return false;
  };

  const runAutoDjRefill = async (queue, { vc, guildId, listeners, force }) => {
    // Si la cola original ya no está viva (Stop / disconnect), no tocar nada.
    const liveNow = client.distube.getQueue(guildId);
    if (!liveNow || !liveNow.songs?.length) return 0;
    queue = liveNow; // usar la instancia actual de la cola

    // Check de cancelación: apagan el AutoDJ, pulsan Stop o destruyen/recrean la
    // cola → el refill se frena (no se siguen sumando canciones ni play() revive).
    const originalQueue = liveNow;
    const isCancelled = () => {
      try {
        if (!client.autoDj?.get(guildId)) return true;
        if (client.playlistStopped?.get?.(guildId)) return true;
        const cur = client.distube.getQueue(guildId);
        if (!cur || cur !== originalQueue) return true;
        if (!cur.songs || cur.songs.length === 0) return true;
        return false;
      } catch (e) { return true; }
    };

    // Al activar (force) o si la fuente quedó vacía (lista pegada a mano, autoresume,
    // la llamada flat falló): la fuente de 🎲 pasa a ser TODA la lista que hay en cola.
    if (force || !AutoDjSource.stateOf(client, guildId).urls.length) {
      AutoDjSource.syncFromQueue(client, guildId, queue);
    }

    // Historial de la sesión, sembrado con el persistente del server para no
    // repetir canciones NI ENTRE SESIONES.
    const seen = seenOf(queue);
    try {
      const persistentSeen = await PlaylistStore.getAutoDjSeen(client, guildId);
      if (Array.isArray(persistentSeen) && persistentSeen.length) {
        for (const url of persistentSeen) if (url && !seen.has(url)) seen.set(url, Date.now());
      }
    } catch (e) {}

    // CICLO ESTRICTO e infinito (ver AutoDjOrder.js), con los oyentes presentes en
    // orden de conexión:
    //   🛸 rec A › 🛸 rec B › 🎲 aleatoria de pedidas A › B › 🎤 novedosa de perfil A › B › 🎲 aleatoria de la lista
    // Ya no depende del patrón guardado en el dashboard: el orden es siempre este.
    const rawPattern = AutoDjOrder.buildCycle(listeners);
    const pattern = rawPattern.slice();
    if (!pattern.length) pattern.push({ type: "random" });

    // Exclusiones: lo que cada oyente pidió NO volver a escuchar con AutoDJ
    // (botón "🚫 No AutoDJ" / 2+ skips).
    const excludeData = await PlaylistStore.getAutodjExcludes(client, guildId).catch(() => ({}));
    const excludedUrls = new Set(Object.values(excludeData || {}).flat());
    // Exclusiones de ESTA sesión (botón 🚫): viven en la cola, no en la DB, y
    // NO se reciclan (a diferencia de _autoDjSeen). Hasta apagar/parar el bot,
    // esas canciones no vuelven a elegirse para nadie.
    if (queue._autoDjExcludedSession && queue._autoDjExcludedSession.size) {
      for (const u of queue._autoDjExcludedSession) if (u) excludedUrls.add(u);
    }
    // Se comparan por CLAVE CANÓNICA (mismo video aunque la URL del pool tenga
    // &list=index v: así el 🚫 de "Psalm 135" atrapa su variante de otra lista).
    const excludedCanon = new Set([...excludedUrls].map((u) => canonUrlKey(u)).filter(Boolean));
    client.logger.log(
      `[AutoDjBan] G:${guildId} exclusiones activas: ${excludedCanon.size} canciones (DB + sesión) filtradas por clave canónica.`
    );

    // ── Señal de SKIP: "esa canción no la repitas tanto" (NO es un veto) ─────
    // Un skip NO saca la canción del AutoDJ (eso era el 🚫 o el ban de 2 skips):
    // solo le baja el PESO, así que entra al final de la bolsa y se sorte con
    // menos chances. El contador es POR USUARIO (quién la saltó), de modo que el
    // paso 🛸 de A no penaliza lo que se le recomienda a B. Para los pasos
    // compartidos (🎲 y 🛸 "cualquiera") no hay destinatario único: se usa el
    // MÁXIMO entre los oyentes de la llamada, así si alguno presente la saltó no
    // se la volvemos a poner como primera opción. Con AUTODJ_SKIP_WEIGHT=0 los
    // skips se ignoran por completo (comportamiento de antes).
    const SKIP_WEIGHT = Math.max(0, Number(process.env.AUTODJ_SKIP_WEIGHT) || 2);
    const skipsData = SKIP_WEIGHT > 0
      ? await PlaylistStore.getAutodjSkips(client, guildId).catch(() => ({}))
      : {};
    // OJO: `skips` se empezó a guardar con la URL CRUDA y después se pasó a la
    // clave canónica "yt:ID". Conviven las dos formas en la misma DB, así que se
    // consultan AMBAS (y se suman): si no, los skips viejos quedaban invisibles.
    const skipCountOf = (url, userId) => {
      if (!url) return 0;
      const byUser = skipsData[canonUrlKey(url)] || skipsData[url.trim()] || skipsData[url];
      if (!byUser) return 0;
      if (userId && userId !== "*") return Number(byUser[userId]) || 0;
      let mx = 0;
      for (const uid of listeners) { const n = Number(byUser[uid]) || 0; if (n > mx) mx = n; }
      return mx;
    };
    // Peso de una candidata: 1 sin skips, ~0.5 con 1, ~0.33 con 2, ~0.25 con 3…
    const skipWeight = (url, userId) => 1 / (1 + SKIP_WEIGHT * skipCountOf(url, userId));
    if (SKIP_WEIGHT > 0) {
      let sk = 0;
      for (const byUser of Object.values(skipsData)) sk += Object.keys(byUser || {}).length;
      if (sk) client.logger.log(`[AutoDjSkip] G:${guildId} ${sk} señal(es) de skip cargadas (peso=${SKIP_WEIGHT}).`);
    }

    // Pool POR USUARIO con solo favoritas reales (con 👍 o guardadas a mano ⭐).
    // Antes se usaba la lista entera: una versión vieja del bot guardaba ahí
    // automáticamente cada canción que sonaba y el AutoDJ metía temas que el
    // usuario nunca pidió.
    const poolsByUser = await PlaylistStore.getAutoDjPoolsByUser(client, guildId, listeners);
    const requestsByUser = {};
    const artistsByUser = {};
    for (const uid of listeners) {
      try {
        requestsByUser[uid] = await UserRequests.getUserRequests(client, guildId, uid) || [];
        // Artistas del PERFIL = exactamente lo que muestra /miperfil en "Artistas que
        // escucha": Spotify (socialprofiles.music) + reproducciones JUGNU (MusicPlay),
        // SUMADOS por nombre (mismo criterio que el comando). Ya no se mezclan las
        // "pedidas" (uploaders de YouTube): metían ruido que no es del perfil.
        const [spotify, perfil] = await Promise.all([
          MusicTracker.spotifyTopArtists(guildId, uid, 40).catch(() => []),
          MusicTracker.topArtists(guildId, uid, 40).catch(() => []),
        ]);
        const merged = new Map();
        const put = (name, count) => {
          const k = String(name || "").trim().toLowerCase();
          if (!k) return;
          const c = Math.max(1, Number(count) || 1);
          const prev = merged.get(k);
          if (!prev) merged.set(k, { name: String(name).trim(), count: c });
          else prev.count += c;
        };
        for (const a of (spotify || [])) put(a.name, a.count);
        for (const a of (perfil || [])) put(a.name, a.count);
        artistsByUser[uid] = [...merged.values()].sort((a, b) => (b.count || 0) - (a.count || 0));
      } catch {
        requestsByUser[uid] = [];
        artistsByUser[uid] = [];
      }
    }
    const artistNameOf = (t) => {
      const u = t?.uploader;
      const raw = (u && (u.name || u.url || u)) || t?.artist || null;
      return typeof raw === "string" ? raw.trim().toLowerCase() : null;
    };
    // Normaliza nombres de canal/artista de YouTube ("Kanye West - Topic" ≈
    // "Kanye West", "Michael Jackson Official", "XVEVO").
    const artistKey = (x) => String(x || "").trim().toLowerCase()
      .replace(/\s*-\s*topic$/i, "")
      .replace(/vevo$/i, "")
      .replace(/\s*-\s*(official|oficial)(\s+(audio|video|music video))?$/i, "")
      .replace(/\s+(official|oficial)$/i, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Pesos del perfil: se separan colaboraciones ("bizarrap; milo j") y cada
    // artista suma. Map { claveArtista: peso }.
    // Construye el mapa ponderado { claveArtista: peso } desde el perfil. Si
    // `topN` > 0, se queda SOLO con los N artistas más escuchados (ej: milo j y
    // kidd voodoo), ignorando el resto (Kanye/uni/...). Así el paso 🎤 recomienda
    // únicamente canciones de los artistas TOP del perfil.
    const ARTIST_TOP_N = Math.max(0, Number(process.env.AUTODJ_ARTIST_TOP_N ?? 16) || 0);
    const artistWeightMap = (list, topN = ARTIST_TOP_N) => {
      const acc = new Map();
      for (const a of (Array.isArray(list) ? list : [])) {
        const parts = String(a?.name || "").split(/\s*(?:;|&|\bfeat\.?\b|\bft\.?\b|\bx\b)\s*/i);
        for (const p of parts) {
          const k = artistKey(p);
          if (!k) continue;
          acc.set(k, (acc.get(k) || 0) + Math.max(1, Number(a?.count) || 1));
        }
      }
      if (!topN || acc.size <= topN) return acc;
      const kept = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
      return new Map(kept);
    };
    // Nombres "reales" de los N artistas más escuchados del perfil (para buscar
    // en YouTube al vuelo cuando no hay canciones suyas guardadas en el server).
    const topArtistNames = (list, topN = ARTIST_TOP_N) => {
      const agg = new Map(); // keyNormalizada -> { name, count }
      for (const a of (Array.isArray(list) ? list : [])) {
        const raw = String(a?.name || "").trim();
        if (!raw) continue;
        for (const p of raw.split(/\s*(?:;|&|\bfeat\.?\b|\bft\.?\b|\bx\b)\s*/i)) {
          const nm = p.trim();
          const k = artistKey(nm);
          if (!k) continue;
          const prev = agg.get(k);
          const c = Math.max(1, Number(a?.count) || 1);
          if (!prev) agg.set(k, { name: nm, count: c });
          else prev.count = Math.max(prev.count, c);
        }
      }
      let arr = [...agg.values()].sort((a, b) => b.count - a.count);
      if (topN && arr.length > topN) arr = arr.slice(0, topN);
      return arr;
    };
    // Match ESTRICTO por tokens (nada de substring suelto: "uni" NO debe
    // matchear "universal"). Devuelve el PESO del mejor artista que matchea.
    const artistMatchWeight = (weightMap, raw) => {
      const k = artistKey(raw);
      if (!k || k.length < 2) return 0;
      let best = 0;
      if (weightMap.has(k)) best = Math.max(best, weightMap.get(k));
      for (const [a, w] of weightMap) {
        if (a.length < 2) continue;
        const ok = k === a
          || k.startsWith(a + " ") || k.endsWith(" " + a) || k.includes(" " + a + " ")
          || a.startsWith(k + " ") || a.endsWith(" " + k) || a.includes(" " + k + " ");
        if (ok) best = Math.max(best, w);
      }
      return best;
    };
    for (const uid of listeners) {
      try {
        const reqs = requestsByUser[uid];
        if (Array.isArray(reqs) && reqs.length) {
          const pool = poolsByUser[uid] || (poolsByUser[uid] = []);
          const have = new Set(pool.map((t) => canonUrlKey(t.url)));
          for (const r of reqs) {
            if (!r?.url) continue;
            const k = canonUrlKey(r.url);
            if (have.has(k)) continue;
            have.add(k);
            pool.push({
              url: r.url,
              name: r.name || null,
              uploader: r.artist ? { name: r.artist } : null,
              likedBy: [],
              dislikedBy: [],
              playCount: Number(r.plays) || 0,
              _fromRequest: true,
            });
          }
        }
        // Artistas detectados del usuario → meter canciones de OTROS usuarios
        // (favoritas o pedidas) cuyo artista coincida con los suyos. Se prioriza
        // por el PESO del artista (los que el usuario más escucha primero).
        const weightMap = artistWeightMap(artistsByUser[uid]);
        if (weightMap.size) {
          const pool = poolsByUser[uid] || (poolsByUser[uid] = []);
          const have = new Set(pool.map((t) => canonUrlKey(t.url)));
          for (const otherUid of listeners) {
            if (otherUid === uid) continue;
            const others = [
              ...(poolsByUser[otherUid] || []),
              ...(requestsByUser[otherUid] || []).map((r) => ({ url: r.url, name: r.name, uploader: r.artist ? { name: r.artist } : null, playCount: Number(r.plays) || 0, _fromRequest: true })),
            ];
            for (const t of others) {
              if (!t?.url) continue;
              const w = artistMatchWeight(weightMap, artistNameOf(t));
              if (!w) continue;
              const k = canonUrlKey(t.url);
              if (have.has(k)) continue;
              have.add(k);
              pool.push({ ...t, _fromArtist: true, _artistWeight: w });
            }
          }
        }
      } catch {}
    }
    // Segundo escalón (rescate): las Favoritas sin 👍/⭐. NUNCA son la primera
    // opción; solo entran cuando ya se vio TODO el pool real, que es lo que
    // provocaba el reciclado (con 19 Pool reales el bot repetía cada poco).
    const ALLOW_UNLIKED = process.env.AUTODJ_ALLOW_UNLIKED !== "0";
    const fallbackPools = ALLOW_UNLIKED
      ? await PlaylistStore.getAutoDjFallbackPoolsByUser(client, guildId, listeners).catch(() => ({}))
      : {};
    // Canciones que cada oyente DE LA LLAMADA pidió reproducir (historial real de
    // lo que pidió, aunque no tenga 👍). Siempre hay temas fuera de la lista
    // actual: se incluyen como candidatas de 🛸.
    const historyByUser = new Map();
    for (const uid of listeners) {
      const hist = await UserHistory.getUniquePlayedPlaylists(client, guildId, uid).catch(() => []);
      if (Array.isArray(hist) && hist.length) historyByUser.set(uid, hist.slice(0, REC_HISTORY_MAX));
    }
    const allHistory = [];
    {
      const seenUrls = new Set();
      for (const hist of historyByUser.values()) {
        for (const t of hist) {
          if (t?.url && !seenUrls.has(t.url)) { seenUrls.add(t.url); allHistory.push(t); }
        }
      }
    }
    // Siempre se cargan las "picks" (1ras canciones de las listas que los oyentes
    // pidieron reproducir): le dan VARIEDAD real a los pasos "aleatoria" sin usar
    // la basura sin like. Antes solo se usaban si no había favoritas.
    const picks = await PlaylistStore.getAutoDjPicks(client, guildId).catch(() => []);
    const anyPool =
      Object.values(poolsByUser).some((p) => p.length) || picks.length > 0 || allHistory.length > 0;
    const listHasCandidates =
      AutoDjSource.candidates(client, guildId, { excluded: new Set(), currentUrl: queue.songs[0]?.url }).length > 0;
    if (!anyPool && !listHasCandidates) {
      client.autoDjReport = client.autoDjReport || new Map();
      client.autoDjReport.set(guildId, { total: 0, rec: 0, random: 0, pattern: [...pattern] });
      client.logger.log(
        `[AutoDJ] G:${guildId} sin pool: nadie tiene canciones con like ni historial de reproducción. ` +
        `Dales 👍 o ⭐ a las que quieras que el bot ponga, o reproducí algo primero.`
      );
      return 0;
    }
    seenTrim(seen, new Set(queue.songs.map((s) => s?.url).filter(Boolean)));

    // Baraja ponderada (Efraimidis-Spirakis): el peso define la probabilidad de
    // salir antes. Un peso chico (muchos skips) la manda hacia el fondo, pero NO
    // la elimina: si es lo único que hay, igual suena.
    const shuffleWeighted = (arr, weightOf) => arr
      .map((t, i) => ({ t, k: Math.random() ** (1 / Math.max(0.01, Number(weightOf(t)) || 0.01)), i }))
      .sort((a, b) => (b.k - a.k) || (a.i - b.i))
      .map((x) => x.t);

    const allPool = Object.values(poolsByUser).flat().filter((t) => t?.url);

    // ── Pools específicos de los pasos nuevos ────────────────────────────────
    // liked      👍  → favoritas con 👍/⭐ del usuario (le gusta sí o sí).
    // pedidas    📝  → canciones que ESE usuario pidió (sus requests).
    // aleatorias 🎰  → al azar entre las pedidas de ESE usuario, priorizando las
    //                  que MENOS se reprodujeron (no repite siempre las mismas).
    // artistas   🎤  → canciones de OTROS cuyo artista está en el perfil del
    //                  usuario (los "_fromArtist" que ya se armaron arriba).
    const likedPoolByUser = {};
    const pedidasPoolByUser = {};
    const aleatoriasPoolByUser = {};
    const artistasPoolByUser = {};
    for (const uid of listeners) {
      const pool = poolsByUser[uid] || [];
      // 🛸 "le gusta SÍ O SÍ": su 👍 propio o guardada a mano por él (⭐), y nunca
      // algo que él haya marcado con 👎. Un 👍 de OTRA persona no cuenta.
      likedPoolByUser[uid] = pool.filter(
        (t) => t?.url && !t._fromRequest && !t._fromArtist &&
          !(t.dislikedBy || []).includes(uid) &&
          ((t.likedBy || []).includes(uid) || t.manual === true)
      );
      pedidasPoolByUser[uid] = pool.filter((t) => t?.url && t._fromRequest);
      aleatoriasPoolByUser[uid] = pool.filter((t) => t?.url && t._fromRequest);
      artistasPoolByUser[uid] = pool.filter((t) => t?.url && t._fromArtist);
    }
    // Etiqueta corta de un paso del patrón para logs.
    const stepShort = (p) => {
      if (!p || p.type === "random") return "🎲";
      const icon = p.type === "liked" ? "🛸" : p.type === "rec" ? "🛸" : p.type === "pedidas" ? "📝" : p.type === "aleatorias" ? "🎲" : p.type === "artistas" ? "🎤" : "🛸";
      return `${icon}:${p.userId}`;
    };
    // Si el paso trae userId "*" y un tipo que necesita destinatario, se reparte
    // de forma CÍCLICA entre los oyentes presentes en orden de conexión.
    //
    // ANTES: el destinatario era `listeners[slotIndex % n]`, donde slotIndex era
    // el índice del paso DENTRO del patrón. Con un patrón de N pasos y M
    // oyentes ese índice sólo cambiaba cada LCM(N, M) → en la práctica el paso
    // "liked" caía SIEMPRE en el mismo oyente (dani_sas) y todas las 🛸/📝/🎤
    // acababan siendo suyas.
    // AHORA: un CONTADOR PROPIO de ciclo (queue._autoDjTurn) que avanza en cada
    // paso "*", de modo que los pasos se reparten round-robin entre TODOS los
    // oyentes. Además se salta a los oyentes que NO tienen contenido para ese
    // tipo de paso (si no, el paso se perdería y la cola quedaría con huecos).
    const hasContentFor = (type, uid) => {
      if (!uid) return false;
      if (type === "liked") return (likedPoolByUser[uid] || []).length > 0;
      if (type === "pedidas" || type === "aleatorias") {
        return (pedidasPoolByUser[uid] || []).length > 0 ||
          (aleatoriasPoolByUser[uid] || []).length > 0 ||
          (requestsByUser[uid] || []).length > 0;
      }
      if (type === "artistas") {
        return (artistasPoolByUser[uid] || []).length > 0 ||
          (artistsByUser[uid] || []).length > 0;
      }
      // "rec"/"rec:*": sus favoritas + su historial.
      return (poolsByUser[uid] || []).length > 0 || (historyByUser.get(uid) || []).length > 0;
    };
    const cycleUser = (type, userId) => {
      if (!type || type === "random") return null;
      if (userId && userId !== "*") return userId;
      if (!listeners.length) return null;
      const n = listeners.length;
      // Contador PROPIO POR TIPO DE PASO: cada tipo rota round-robin entre los
      // oyentes que tienen contenido para ese tipo. Con un contador único los
      // pasos y los oyentes quedaban EMPAREJADOS (al "liked" le tocaba siempre
      // el mismo usuario) porque el turno avanzaba en el mismo orden que el
      // patrón.
      const turns = (queue._autoDjTurn && typeof queue._autoDjTurn === "object")
        ? queue._autoDjTurn
        : (queue._autoDjTurn = {});
      const start = (((turns[type] || 0) % n) + n) % n;
      for (let k = 0; k < n; k++) {
        const idx = (start + k) % n;
        const uid = listeners[idx];
        if (!hasContentFor(type, uid)) continue;
        turns[type] = (idx + 1) % n;
        return uid;
      }
      // Nadie tiene contenido para ese tipo de paso: se entrega el turno igual
      // (el paso caerá a sus fallbacks) para no trabar el ciclo de la cola.
      turns[type] = (start + 1) % n;
      return listeners[start];
    };

    // playCount por URL para el paso 🎲, que maneja URLs sueltas y no objetos
    // con playCount. Se arma con las favoritas de la llamada (las que sí lo
    // traen); lo que no esté, se trata como no reproducido (0).
    const playsByUrl = new Map();
    for (const t of allPool) {
      if (!t?.url) continue;
      const k = canonUrlKey(t.url);
      if (!k) continue;
      playsByUrl.set(k, Math.max(playsByUrl.get(k) || 0, playsOf(t)));
    }
    const playsOfUrl = (u) => playsByUrl.get(canonUrlKey(u)) || 0;

    /**
     * Elige al AZAR (barajado real) la candidata para un paso del patrón.
     *   rec user  → uniforme entre las favoritas de ESE usuario (primero las
     *               de él; si no tiene, cualquier otra de la llamada)
     *   rec *     → uniforme entre las de cualquiera de la llamada
     *   random    → uniforme entre TODAS las favoritas reales de la llamada
     * @param {object} step {type:"rec"|"random", userId}
     * @param {Set<string>} taken urls ya usadas en este refill (no repetir)
     * @param {Set<string>} inQueue urls que ya están en la cola
     */
    const dbg = [];
    const dbgLine = (l) => dbg.push(l);

    // ── Log de decisiones del AutoDJ (archivo separado: logs/autodj.log) ─────
    // Registra por qué se eligió cada canción (origen, 👍/👎, plays totales y de
    // la SESIÓN, skips, peso) más el tamaño de los pools, para poder auditar
    // después que se usen TODAS las canciones de las listas y no solo un subconjunto.
    const srcState = AutoDjSource.stateOf(client, guildId);
    const sessionPlaysOf = (u) => {
      try { return Number(client._sessionPlays?.get?.(guildId)?.get?.(canonUrlKey(u))) || 0; }
      catch (_) { return 0; }
    };
    const poolSnapshot = {
      fuenteConocida: srcState.urls.length,
      fuenteUsadas: srcState.used.size,
      favoritas: allPool.length,
      historial: allHistory.length,
      picks: picks.length,
      rescateSinLike: Object.values(fallbackPools).flat().length,
    };
    const logPick = (entry) => {
      AutoDjLogger.decision({
        guildId,
        oyentes: listeners,
        patron: pattern.map((p) => (p.type === "random" ? "random" : `${p.type}:${p.userId}`)),
        fuenteMomentanea: AutoDjSource.candidates(client, guildId, { currentUrl: queue.songs[0]?.url }).length,
        ...poolSnapshot,
        ...entry,
      }, entry.origen === "random" ? "pick.random" : "pick.rec");
    };

    const pickForStepInner = async (step, taken, inQueue) => {
      // Destinatario efectivo del paso: si es "*" y el tipo necesita un usuario,
      // se reparte de forma cíclica entre los oyentes (orden de conexión).
      const effUser = cycleUser(step.type, step.userId);
      // 🎲 → al azar entre TODAS las canciones de la lista ingresada que aún no
      // sonaron ni se eligieron (aunque el loader no las haya encolado todavía).
      // Sin reposición: cada una sale una sola vez por sesión. Si la lista ya no
      // tiene candidatas, cae al pool de favoritas/historial/picks de siempre.
      if (step.type === "random") {
        let cand = AutoDjSource.candidates(client, guildId, {
          excluded: excludedUrls,
          taken,
          currentUrl: queue.songs[0]?.url,
        }).filter((u) => !excludedCanon.has(canonUrlKey(u)));
        // Lista agotada: se vuelve a empezar por lo que MÁS tiempo hace que sonó
        // (infinito, pero siempre de la lista cargada).
        if (!cand.length) {
          const old = AutoDjSource.recyclable(client, guildId, {
            excluded: excludedUrls,
            taken,
            currentUrl: queue.songs[0]?.url,
            inQueue,
          }).filter((u) => !excludedCanon.has(canonUrlKey(u)));
          if (old.length) {
            cand = [old[0]];
            AutoDjSource.unuse(client, guildId, old[0]);
            dbgLine(`🎲 random: lista agotada -> se recicla la más antigua ${old[0]}`);
          }
        }
        if (cand.length) {
          const url = pickLeastPlayed(cand, (u) => skipWeight(u, "*"), playsOfUrl);
          taken.add(url);
          dbgLine(`🎲 random: candidatas=${cand.length} -> ${url} (skips oyentes=${skipCountOf(url, "*")})`);
          logPick({
            origen: "random",
            motivo: "lista-sin-usar",
            url,
            nombre: null,
            yaEnCola: inQueue.has(url),
            candidatasLista: cand.length,
            skips: skipCountOf(url, "*"),
            playsTotales: playsOfUrl(url),
            playsSesion: sessionPlaysOf(url),
            peso: Number(skipWeight(url, "*").toFixed(3)),
          });
          return { url, name: null, existing: inQueue.has(url), fromList: true };
        }
        // Sin canciones de la lista (no hay lista cargada): este paso se SALTA. Antes
        // caía al pool de favoritas/historial/pedidas y la 🎲 "de la lista" sonaba algo
        // que no era de la lista.
        dbgLine(`🎲 random: sin canciones de la lista -> paso omitido`);
        return null;
      }
      // Una PLAYLIST no puede ser candidata de rec (el pool trae URLs de listas
      // del historial: recomendarlas = "revivir otra lista", y la 1ª canción
      // aislada de esa lista es la que el usuario ve reaparecer como "no
      // relacionada"). Además SOLO entran candidatas que resuelven RÁPIDO como
      // single (isSafeSingle): los sets de SoundCloud hicieron que un play()
      // colgara 45-60s por candidata.
      const isSafeCand = (t) => t?.url && !isPlaylistURL(t.url) && isSafeSingle(t.url);
      let pool;
      if (step.type === "liked") {
        // 👍 "le gusta sí o sí": SOLO sus favoritas con like/⭐ (sin historial
        // ajeno). Ordenadas por score; si se agotan se reciclan (abajo).
        const src = (likedPoolByUser[effUser] || []).filter(isSafeCand);
        const score = (t) => ((t.likedBy || []).length - (t.dislikedBy || []).length) * 10 + (t.playCount || 0) - SKIP_WEIGHT * skipCountOf(t.url, effUser);
        pool = src.slice().sort((a, b) => score(b) - score(a));
      } else if (step.type === "pedidas") {
        // 📝 aleatoria de lo que ESE usuario pidió (con reposición, es corto).
        const src = (pedidasPoolByUser[effUser] || []).filter(isSafeCand);
        const have = new Set(src.map((t) => canonUrlKey(t.url)));
        const extra = (requestsByUser[effUser] || [])
          .map((r) => ({ url: r.url, name: r.name || null, uploader: r.artist ? { name: r.artist } : null, likedBy: [], dislikedBy: [], playCount: Number(r.plays) || 0, _fromRequest: true }))
          .filter((t) => isSafeCand(t) && !have.has(canonUrlKey(t.url)));
        pool = shuffleWeighted(src.concat(extra), (t) => skipWeight(t.url, effUser));
      } else if (step.type === "aleatorias") {
        // 🎰 aleatoria entre las pedidas de ESE usuario, priorizando las que
        // MENOS se reprodujeron: se elige ponderado SOLO entre el cuartil menos
        // escuchado (evita repetir siempre las mismas pedidas). Seleccion directa
        // (como random), sin pasar por el orden "mas gustado".
        const src = (aleatoriasPoolByUser[effUser] || []).filter(isSafeCand);
        const have = new Set(src.map((t) => canonUrlKey(t.url)));
        const extra = (requestsByUser[effUser] || [])
          .map((r) => ({ url: r.url, name: r.name || null, uploader: r.artist ? { name: r.artist } : null, likedBy: [], dislikedBy: [], playCount: Number(r.plays) || 0, _fromRequest: true }))
          .filter((t) => isSafeCand(t) && !have.has(canonUrlKey(t.url)));
        const all = src.concat(extra);
        if (all.length) {
          const chosen = pickLeastPlayed(all, (t) => skipWeight(t.url, effUser));
          if (chosen?.url) {
            taken.add(chosen.url);
            logPick({
              origen: "aleatorias",
              motivo: "pedida-menos-escuchada",
              paso: `${step.type}:${effUser || "*"}`,
              destinatario: effUser || null,
              url: chosen.url,
              nombre: chosen.name || null,
              yaEnCola: inQueue.has(chosen.url),
              candidatas: all.length,
              skips: skipCountOf(chosen.url, effUser),
              likes: (chosen.likedBy || []).length,
              dislikes: (chosen.dislikedBy || []).length,
              playsTotales: playsOf(chosen),
              playsSesion: sessionPlaysOf(chosen.url),
              peso: Number(skipWeight(chosen.url, effUser).toFixed(3)),
            });
            return { url: chosen.url, name: chosen.name || null, existing: inQueue.has(chosen.url), fromList: false, autoDjType: "aleatorias", autoDjUserId: effUser || null };
          }
        }
        dbgLine(`🎲 pedidas: el usuario no tiene pedidas -> paso omitido`);
        return null;
      } else if (step.type === "artistas") {
        // 🎤 "novedosa de artistas del perfil": candidatas cuyo artista está en
        // el perfil del usuario (los _fromArtist). Selección DIRECTA priorizando
        // el artista MÁS escuchado por el usuario (peso), y entre esos, lo menos
        // visto. Sin esto, un Kanye con más likes globales ganaba siempre aunque
        // el usuario escuche milo j/kidd voodoo. Si no hay, cae a rec.
        let src = (artistasPoolByUser[effUser] || []).filter(isSafeCand);
        if (src.length) {
          // Excluir lo que el usuario ya conoce (su propio pool/historial) y lo
          // que ya está en cola/cerca, para que sea NOVEDOSA de verdad.
          const ownNow = new Set((poolsByUser[effUser] || []).map((t) => t.url));
          src = src.filter((t) => !seen.has(t.url) && !taken.has(t.url) && !ownNow.has(t.url));
        }
        if (src.length) {
          src = src.slice().sort((a, b) => {
            const d = (b._artistWeight || 0) - (a._artistWeight || 0);
            if (d) return d;
            return skipWeight(b.url, effUser) - skipWeight(a.url, effUser);
          });
          // El pool ya está restringido a los artistas TOP del perfil (mapa
          // limitado a AUTODJ_ARTIST_TOP_N, por defecto 2). Dentro de esos,
          // elegimos lo MENOS visto/reproducido (canciones nuevas para él),
          // repartiendo entre los top-2 sin quedar pegado sólo al #1.
          const chosen = pickLeastPlayed(src, (t) => skipWeight(t.url, effUser), (t) => playsOf(t));
          if (chosen?.url) {
            taken.add(chosen.url);
            logPick({
              origen: "artistas",
              motivo: "artista-perfil",
              paso: `${step.type}:${effUser || "*"}`,
              destinatario: effUser || null,
              url: chosen.url,
              nombre: chosen.name || null,
              yaEnCola: inQueue.has(chosen.url),
              candidatas: src.length,
              artistaPeso: chosen._artistWeight || 0,
              skips: skipCountOf(chosen.url, effUser),
              likes: (chosen.likedBy || []).length,
              dislikes: (chosen.dislikedBy || []).length,
              playsTotales: playsOf(chosen),
              playsSesion: sessionPlaysOf(chosen.url),
              peso: Number(skipWeight(chosen.url, effUser).toFixed(3)),
            });
            return { url: chosen.url, name: chosen.name || null, existing: inQueue.has(chosen.url), fromList: false, autoDjType: "artistas", autoDjUserId: effUser || null };
          }
        }
        // Fallback: no hay canciones guardadas de los artistas TOP en el server
        // (ej. milo j/kidd voodoo). Se BUSCAN en YouTube al vuelo y se elige una
        // NUEVA (no vista, no en cola, no ya escuchada por el usuario).
        {
          const tops = shuffleWeighted(topArtistNames(artistsByUser[effUser]), (a) => a.count);
          if (tops.length) {
            const ownPool = new Set((poolsByUser[effUser] || []).map((t) => t.url));
            const ownHist = new Set((historyByUser.get(effUser) || []).map((t) => t?.url).filter(Boolean));
            for (const top of tops) {
              const results = await searchArtistSongs(client, top.name);
              const fresh = results.filter((r) => r?.url
                && !seen.has(r.url) && !taken.has(r.url) && !inQueue.has(r.url)
                && !ownPool.has(r.url) && !ownHist.has(r.url)
                && isSafeCand(r));
              if (!fresh.length) continue;
              // Distribución (aleatoria) dentro de lo nuevo para no repetir el
              // mismo resultado siempre; se evita la primera posición trivial.
              const pool2 = fresh.length > 1 ? fresh.slice(1) : fresh;
              const chosen = pool2[Math.floor(Math.random() * pool2.length)];
              if (!chosen?.url) continue;
              taken.add(chosen.url);
              logPick({
                origen: "artistas",
                motivo: "artista-perfil-youtube",
                paso: `${step.type}:${effUser || "*"}`,
                destinatario: effUser || null,
                url: chosen.url,
                nombre: chosen.name || null,
                yaEnCola: false,
                candidatas: fresh.length,
                artistaBuscado: top.name,
                skips: 0,
                likes: 0,
                dislikes: 0,
                playsTotales: 0,
                playsSesion: 0,
                peso: 1,
              });
              return { url: chosen.url, name: chosen.name || null, existing: false, fromList: false, autoDjType: "artistas", autoDjUserId: effUser || null };
            }
          }
        }
        dbgLine(`🎤 novedad: sin canciones nuevas de los artistas del perfil -> paso omitido`);
        return null;
      } else if (step.type === "rec" && effUser) {
        const own = (poolsByUser[effUser] || []).filter((t) => isSafeCand(t));
        const ownUrls = new Set(own.map((t) => t.url));
        const scratch = (historyByUser.get(effUser) || []).filter((t) => isSafeCand(t) && !ownUrls.has(t.url));
        const ownHist = scratch.slice(0, REC_HISTORY_MAX).filter((t) => t?.url);
        // REC PARA UN USUARIO = SOLO lo que le gusta escuchar: sus favoritas
        // ordenadas por score (likes×10 + reproducciones) y su historial.
        // NO se meten "picks" (1ras canciones de listas ajenas) ni historial de
        // otros: por eso "Psalm 135" (primera de OTRA lista, sin un solo like) no
        // debe volver a recomendarse.
        // El score además descuenta los SKIPS de ESE usuario: no desaparece del
        // pool (si es su única favorita sigue sonando), pero cae en la lista.
        const score = (t) => ((t.likedBy || []).length - (t.dislikedBy || []).length) * 10 + (t.playCount || 0) - SKIP_WEIGHT * skipCountOf(t.url, effUser);
        pool = [
          ...own.slice().sort((a, b) => score(b) - score(a)),
          ...ownHist.slice().sort((a, b) => score(b) - score(a)),
        ];
        const inPoolUser = new Set(pool.map((t) => t?.url));
        const third = allPool.filter((t) => isSafeCand(t) && !ownUrls.has(t.url) && !inPoolUser.has(t.url));
        if (third.length) pool = pool.concat(shuffleWeighted(third, (t) => skipWeight(t.url, "*")));
      } else {
        pool = shuffleWeighted(allPool.filter((t) => isSafeCand(t)), (t) => skipWeight(t.url, "*"));
        // Historias de TODOS los oyentes de la llamada (lo que pidieron reproducir,
        // aunque sea de otras listas que ya no están en esta cola). NO se incluyen
        // las URLs de playlist (recomendarlas = meter otra lista entera).
        if (allHistory.length) {
          const inPool = new Set(pool.map((t) => t?.url));
          const extra = allHistory.filter((t) => isSafeCand(t) && !inPool.has(t.url));
          if (extra.length) pool = pool.concat(shuffleWeighted(extra, (t) => skipWeight(t.url, "*")));
        }
        if (picks.length) pool = pool.concat(shuffleWeighted(picks.filter((t) => isSafeCand(t)), (t) => skipWeight(t.url, "*")));
      }

      // ── Pool de la SALA para oyentes sin contenido propio ──────────────────
      // Quien está en la llamada pero NO tiene favoritas/likes/pedidas propias
      // antes se quedaba sin turno (el paso salía "SIN" y todo caía a quien sí
      // tenía datos). Ahora, cuando el pool propio no da canciones nuevas, se le
      // recomienda de lo que les gusta a los OTROS oyentes (sin lo que él haya
      // 👎), y la canción queda a su nombre (🛸 <usuario>).
      const roomPoolFor = (uid) => {
        if (!uid) return [];
        const out = [];
        const have = new Set();
        const add = (t) => {
          if (!t?.url || !isSafeCand(t)) return;
          if ((t.dislikedBy || []).includes(uid)) return;
          const k = canonUrlKey(t.url);
          if (have.has(k)) return;
          have.add(k);
          out.push(t);
        };
        for (const other of listeners) {
          if (other === uid) continue;
          (likedPoolByUser[other] || []).forEach(add);
        }
        allPool.forEach(add);
        return shuffleWeighted(out, (t) => skipWeight(t.url, uid));
      };
      // Orden por antigüedad de uso: lo que el bot puso hace MÁS tiempo primero
      // (lo nunca puesto, antes que todo). Evita que un pool chico gire siempre
      // sobre las mismas 2-3 canciones al reciclar.
      const rankByRecency = (arr) => {
        const rec = queue._autoDjRecent || [];
        const idxOf = (t) => rec.lastIndexOf(canonUrlKey(t.url));
        const sorted = arr.slice().sort((a, b) => idxOf(a) - idxOf(b));
        return sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
      };

      // No recomendar lo que ya está en la cola y PRÓXIMO a sonar (ni la canción
      // que está sonando): se descartan los primeros ~REC_MIN_GAP de la lista.
      // Pero una favorita que quedó LEJOS en la cola (o que ya dejó de estar)
      // SÍ se usa: se "adelanta" al hueco del bot y el loader salta la usada,
      // así se recomiendan aunque sean pocas los likes y nunca se duplican.
      const nearQueue = new Set();
      for (const [i, s] of queue.songs.entries()) {
        if (s?.url && (i === 0 || i <= REC_MIN_GAP)) nearQueue.add(s.url);
      }
      const tag = `pool=${pool.length} (favs=${allPool.length} hist=${allHistory.length} picks=${picks.length}) near=${nearQueue.size}`;
      const weightOf = (t) => skipWeight(t.url, effUser || step.userId);
      const isUsableNow = (t) => t?.url && !excludedCanon.has(canonUrlKey(t.url)) && !nearQueue.has(t.url);
      const freshOf = (arr) => arr.filter((t) => isUsableNow(t) && !seen.has(t.url) && !taken.has(t.url));
      // Tres escalones, en orden. Antes el paso 3 (reciclar) saltaba siempre al
      // final porque pickUnseen nunca devolvía null, y encima elegía SIEMPRE la
      // primera de la lista: por eso se repetían las mismas 2-3 canciones.
      let found = null;
      let usedFallback = false;
      // 1) Alguna favorita REAL sin ver → la más LIKEADA primero, nunca se repite.
      const freshReal = freshOf(pool);
      let motivo;
      if (freshReal.length) {
        found = pickMostLiked(freshReal, weightOf);
        motivo = "favorita-nueva";
      } else if (ALLOW_UNLIKED && step.type === "rec") {
        // 2) El pool REAL ya se vio entero → Favoritas SIN 👍 (nunca con 👎).
        //    Con un pool real chico esto es lo que evita el reciclado constante:
        //    las candidatas pasan de 24 a 84.
        //    Solo para pasos "rec": liked/pedidas/artistas son pools cerrados de
        //    gusto del usuario y NO deben rellenarse con rescates sin like.
        const fbFresh = freshOf(Object.values(fallbackPools).flat().filter(isSafeCand));
        if (fbFresh.length) {
          found = pickLeastPlayed(fbFresh, weightOf);
          usedFallback = true;
          motivo = "rescate-sin-like";
        }
      }
      // 2.5) Sin nada nuevo en SU pool: lo que les gusta a los demás oyentes,
      //      a nombre de este usuario (nunca para 🎲 random, que es global).
      if (!found && effUser && step.type === "rec") {
        const roomFresh = freshOf(roomPoolFor(effUser));
        if (roomFresh.length) {
          found = pickMostLiked(roomFresh, weightOf);
          motivo = "sala-nueva";
        }
      }
      // 3) No queda nada sin ver: se recicla, pero rotando por ANTIGÜEDAD (lo que
      //    hace más tiempo que el bot no pone), no al azar. Con pool propio chico
      //    se mezclan también las de la sala para que no giren las mismas 2-3.
      if (!found) {
        const base = (effUser && step.type === "rec" && pool.length < 8)
          ? pool.concat(roomPoolFor(effUser).filter((t) => !pool.some((p) => canonUrlKey(p.url) === canonUrlKey(t.url))))
          : pool;
        found = pickUnseen(rankByRecency(base), seen, excludedCanon, nearQueue, weightOf);
        motivo = "reciclada";
      }
      if (found && !taken.has(found.url)) {
        taken.add(found.url);
        found.existing = inQueue.has(found.url);
        found.autoDjType = step.type;
        found.autoDjUserId = effUser || null;
        // Si el paso no encontró lo suyo y cayó a otra fuente, el rótulo lo dice.
        found.autoDjFallback = motivo === "sala-nueva" ? "sala"
          : motivo === "reciclada" ? "reciclada"
          : motivo === "rescate-sin-like" ? "rescate" : null;
        const icon = step.type === "random" ? "🎲" : step.type === "liked" ? "👍" : step.type === "pedidas" ? "📝" : step.type === "aleatorias" ? "🎰" : step.type === "artistas" ? "🎤" : "🛸";
        dbgLine(
          `${icon} ${step.type}: ${tag}` +
          ` skips=${skipCountOf(found.url, effUser || step.userId)}` +
          ` -> ${found.url}${found.fromList ? " (lista)" : ""}` +
          `${usedFallback ? " [sin 👍 → rescate]" : ""}` +
          `${found.existing ? " [ya en cola→se adelanta]" : " [nueva→play()]"}`
        );
        logPick({
          origen: step.type === "random" ? "random" : "rec",
          tipo: step.type,
          motivo,
          paso: effUser ? `${step.type}:${effUser}` : `${step.type}:*`,
          destinatario: effUser || null,
          url: found.url,
          nombre: found.name || found.title || null,
          yaEnCola: !!found.existing,
          fromList: !!found.fromList,
          likes: (found.likedBy || []).length,
          dislikes: (found.dislikedBy || []).length,
          skips: skipCountOf(found.url, effUser || step.userId),
          playsTotales: found.playCount ?? playsOfUrl(found.url),
          playsSesion: sessionPlaysOf(found.url),
          peso: Number(skipWeight(found.url, effUser || step.userId).toFixed(3)),
          candidatas: pool.length,
        });
        return found;
      }
      dbgLine(`🛸 rec: ${tag} -> SIN (descartadas por seen/excl/taken/near)`);
      return null;
    };

    // Registro de lo que el bot puso (más reciente al final): alimenta la rotación
    // por antigüedad de arriba. Va en un wrapper para cubrir TODOS los pasos
    // (random, aleatorias, artistas, liked…) sin tocar cada return.
    const noteRecent = (url) => {
      const k = canonUrlKey(url);
      if (!k) return;
      const r = queue._autoDjRecent || (queue._autoDjRecent = []);
      const i = r.indexOf(k);
      if (i >= 0) r.splice(i, 1);
      r.push(k);
      if (r.length > 150) r.splice(0, r.length - 150);
    };
    const pickForStep = async (step, taken, inQueue) => {
      const res = await pickForStepInner(step, taken, inQueue);
      if (res?.url) noteRecent(res.url);
      return res;
    };

    // ---- Sumar siguiendo el patrón, intercalado EN MEDIO de la lista ----
    // Las canciones del bot viven en HUECOS fijos de la cola. El primer ciclo del
    // patrón va consecutivo al frente (1,2,3,4…) para que la mezcla se vea desde
    // la primera página; el resto se intercala con un tema tuyo entre cada dos.
    // Se mantienen LOOKAHEAD_CYCLES ciclos del patrón por delante y SOLO se
    // repone el hueco que queda vacío. Si la cola es corta, rellena con al menos
    // 1 para no quedarse en silencio.
    const LOOKAHEAD_CYCLES = Math.max(1, Number(process.env.AUTODJ_LOOKAHEAD_CYCLES) || 2);
    const targetBot = pattern.length * LOOKAHEAD_CYCLES;
    const upNext = queue.songs.length - 1;
    // MEZCLA DESDE EL FRENTE: el primer ciclo del patrón ocupa consecutivamente
    // las primeras posiciones en orden exacto por rondas:
    // ronda1: (rec u1, rec u2, ...) / ronda2: (aleat u1, aleat u2, ...) / ronda3: (artistas u1,...)
    // para que la PRIMERA PÁGINA del embed se vea SIEMPRE en ese orden.
    const frontMix = process.env.AUTODJ_FRONT_MIX !== "0";
    const SLOT_GAP = Math.max(1, Number(process.env.AUTODJ_SLOT_GAP) || (frontMix ? 2 : 3));
    const frontCycle = frontMix ? Math.min(pattern.length, targetBot) : 0;
    // El reacomodo de la cola (relayoutQueue) usa estos mismos parámetros.
    queue._autoDjLayout = { frontMix, frontCycle, gap: SLOT_GAP };
    // Cantidad de canciones del bot que YA están en la cola (sin contar la actual).
    const botNow = queue.songs.slice(1).filter((s) => s && (s.autoDj || s._autoDj)).length;
    let toAdd = Math.max(0, targetBot - botNow);
    const botSlots = [];
    for (let k = 0; k < targetBot; k++) {
      if (k < frontCycle) botSlots.push(1 + k);
      else botSlots.push(frontCycle + (k - frontCycle + 1) * SLOT_GAP);
    }
    const missingSlots = botSlots.slice(0, toAdd);
    if (upNext < 4) {
      // Cola muy corta: rellena con 1, pero solo si NO hay ya una del bot
      // esperando (evita encadenar 🛸 seguidas mientras carga la lista).
      const botPending = queue.songs.slice(1).some((s) => s && (s.autoDj || s._autoDj));
      if (!botPending) toAdd = Math.max(toAdd, 1);
    }
    if (toAdd <= 0) return 0;

    const inQueue = new Set(queue.songs.map((s) => s?.url).filter(Boolean));
    const taken = new Set();
    // El ciclo SIGUE desde el último paso intentado (aunque esa canción ya haya
    // sonado o el oyente haya cambiado): nunca se reinicia ni se desfasa.
    const si = AutoDjOrder.nextStepIndex(pattern, queue._autoDjLast, listeners);
    const block = [];
    for (let i = 0; i < toAdd; i++) {
      const step = pattern[(si + i) % pattern.length];
      queue._autoDjLast = { type: step.type, userId: step.userId || null };
      const pick = await pickForStep(step, taken, inQueue);
      if (!pick) continue;
      // Secuencia de ELECCIÓN: define el orden visual del bloque del bot (no el
      // orden en que terminen de resolverse las canciones).
      queue._autoDjSeqCounter = Math.max(
        Number(queue._autoDjSeqCounter) || 0,
        ...queue.songs.map((x) => Number(x && x._autoDjSeq) || 0)
      ) + 1;
      pick.autoDjSeq = queue._autoDjSeqCounter;
      seenMark(seen, pick.url);
      // Usada: el loader no la encola de nuevo y la 🎲 no la repite.
      AutoDjSource.markUsed(client, guildId, pick.url);
      block.push({ track: pick, step, existing: !!pick.existing });
      inQueue.add(pick.url);
      // Evitar repetir la MISMA canción inmediatamente (ej: "Call your name" se colaba
      // 2-3 veces seguidas). Si el siguiente paso vuelve a sacar la misma URL, se
      // salta esa repetición y se intenta con otro paso en el próximo refill.
      if (block.length >= 2 && block[block.length - 1]?.track?.url && block[block.length - 2]?.track?.url &&
        block[block.length - 1].track.url === block[block.length - 2].track.url) {
        const last = block.pop();
        if (last?.track?.url) taken.delete(last.track.url);
      }
    }
    if (!block.length) {
      client.logger.log(
        `[AutoDJ] G:${guildId} refill: patrón=${pattern.map((p) => stepShort(p)).join(">")}` +
        ` huecos=${botSlots.join(",")} faltan=${missingSlots.join(",")} toAdd=${toAdd} oyentes=${listeners.join(",")} turno=${JSON.stringify(queue._autoDjTurn || {})}`
      );
      for (const l of dbg) client.logger.log(`[AutoDJ] G:${guildId}   ${l}`);
      return 0;
    }
    // El patrón avanza UN PASO por hueco intentados (no por canciones
    // agregadas): así el paso del patrón queda alineado con el hueco de la
    // cola. Antes avanzaba por `block.length`, o sea que un paso que fallaba
    // se saltaba y el patrón se desfasaba respecto de los huecos (el hueco
    // que quedó vacío lo llenaba otro paso al refill siguiente).
    // (el avance del ciclo ya quedó en queue._autoDjLast, paso por paso)
    client.logger.log(
      `[AutoDJ] G:${guildId} refill: patrón=${pattern.map((p) => stepShort(p)).join(">")}` +
      ` huecos=${botSlots.join(",")} faltan=${missingSlots.join(",")} toAdd=${toAdd} oyentes=${listeners.join(",")} turno=${JSON.stringify(queue._autoDjTurn || {})}`
    );
    for (const l of dbg) client.logger.log(`[AutoDJ] G:${guildId}   ${l}`);

    // Resumen del refill en el log dedicado: permite ver de un vistazo si TODAS
    // las canciones de la fuente entran al sorteo o si el pool real es chico.
    AutoDjLogger.decision({
      guildId,
      oyentes: listeners,
      patronEfectivo: pattern.map((p) => (p.type === "random" ? "random" : `${p.type}:${p.userId}`)),
      patronConfigurado: rawPattern.map((p) => (p.type === "random" ? "random" : `${p.type}:${p.userId}`)),
      refillAgregadas: block.length,
      huecosFaltantes: missingSlots.length,
      toAdd,
      ...poolSnapshot,
      candidatasListaRestantes: AutoDjSource.candidates(client, guildId, { currentUrl: queue.songs[0]?.url }).length,
    }, "refill.resumen");

    // Materializar como Song objects reales (DisTube necesita la resolución).
    // Para "rec de fulano" se usa el member de ESE usuario (la canción queda a
    // su nombre en la cola); para "random" el fallback es el que pidió la cola
    // o el bot. Se guarda de dónde vino cada una (tipo + usuario).
    const fallbackMember = queue.songs[0]?.member || (listeners.length === 1 ? (vc?.guild?.members?.cache?.get(listeners[0]) || vc?.guild?.members?.me) : (listeners.length > 0 ? (vc?.guild?.members?.cache?.get(listeners[0]) || vc?.guild?.members?.me) : (vc?.guild?.members?.me)));
    const addedMeta = new Map(); // url -> { type, userId }
    const movedByUrl = new Map(); // url -> Song que ya estaba en la cola y se movió
    for (const item of block) {
      // Si mientras tanto apagaron el AutoDJ / pulsaron Stop / la cola murió:
      // NO seguir sumando más canciones (ni reconectar con play()).
      if (isCancelled()) {
        client.logger.log(`[AutoDJ] G:${guildId} refill cancelado (Stop / AutoDJ off / cola muerta)`);
        break;
      }
      const url = item.track.url;
      const step = item.step;
      // El usuario EFECTIVO (tras la rotación cíclica) y el TIPO real vienen en el
      // pick; así el embed fijo puede mostrar qué lógica se usó y para quién.
      let effectiveUser = item.track.autoDjUserId || (step.userId && step.userId !== "*" ? step.userId : null);
      if (item.track?.fromList && !effectiveUser) {
        // si es aleatoria de lista, intentar repartir entre oyentes
        if (listeners.length) effectiveUser = listeners[(si + addedMeta.size) % listeners.length];
      }
      if (!effectiveUser && step.userId && step.userId !== "*") effectiveUser = step.userId;
      if (!effectiveUser && listeners.length) {
        // distribuir por orden
        effectiveUser = listeners[Math.floor(Math.random() * listeners.length)];
      }
      const effectiveType = item.track.autoDjType || (step.type === "random" ? "random" : "rec");
      const meta = {
        type: effectiveType,
        userId: effectiveType === "random" ? null : effectiveUser,
        seq: item.track.autoDjSeq,
        fallback: item.track.autoDjFallback || null,
      };
      let member = fallbackMember;
      if (effectiveUser) {
        member = vc?.guild?.members?.cache?.get(effectiveUser)
          || vc?.guild?.members?.me
          || fallbackMember;
        const m2 = vc?.guild?.members?.cache?.get(effectiveUser);
        if (m2) member = m2;
      } else if (listeners.length === 1) {
        const only = vc?.guild?.members?.cache?.get(listeners[0]);
        if (only) member = only;
      } else if (listeners.length > 1) {
        // repartir entre todos
        const idx = (addedMeta.size) % listeners.length;
        const m2 = vc?.guild?.members?.cache?.get(listeners[idx]);
        if (m2) { member = m2; effectiveUser = effectiveUser || listeners[idx]; }
      }
      // La 🎲 de la lista no es de NINGÚN oyente: queda a nombre del bot (así no
      // cuenta como "pedida" de nadie ni recibe prioridad de pedido).
      if (effectiveType === "random") {
        member = vc?.guild?.members?.me || member;
      }
      try {
        if (item.existing) {
          // Ya está en la cola (el loader la cargó antes): se MUEVE al hueco del
          // AutoDJ en vez de encolarla otra vez (así nunca queda duplicada).
          const live = client.distube.getQueue(guildId);
          const idx = live ? live.songs.findIndex((x, i) => i > 0 && x?.url === url) : -1;
          if (idx > 0) {
            const [song] = live.songs.splice(idx, 1);
            movedByUrl.set(url, song);
            addedMeta.set(url, meta);
            flagBotSong(live, song, meta, false);
            live.songs.splice(idx, 0, song);
          }
          continue;
        }
        // NUNCA pasar a play() algo que DisTube resuelva como LOTE (playlist /
        // set): DisTube espera por TODOS sus videos (minutos si hay caídos o
        // age-gate) y ese play() "colgado" congela la transición ACTUAL y la
        // siguiente. Además, abandonarlo con timeout NO lo cancela: DisTube
        // termina resolviendo en el fondo e inserta la lista igual (eso es lo
        // que "se añadió una lista y se saltaron 3 canciones" en los logs).
        const cleanUrl = cleanYtUrl(url);
        if (!isSafeSingle(cleanUrl)) {
          // Es una lista/set: se intenta tocar SOLO su 1ª canción (rápido, sin
          // esperar el resto). Si no se puede aislar, se descarta la candidata.
          const first = await fetchPlaylistFirstURL(cleanUrl, { timeoutMs: 20000 });
          if (first && isSafeSingle(first)) {
            const single = cleanYtUrl(first);
            // La 1ª canción de la lista puede estar BANEADA con 🚫 (aunque la
            // URL de la lista no lo esté): no reintroducirla.
            if (excludedCanon.has(canonUrlKey(single))) {
              seenMark(seen, url);
              AutoDjSource.markUsed(client, guildId, url);
              client.logger.warn(`[AutoDJ] G:${guildId} ${single} (1ª de la lista ${url}) está baneada con 🚫: se descarta`);
              continue;
            }
            item.playUrl = single;
            const t0 = Date.now();
            await enqueueBot(queue, single, meta, () =>
              enqueueSong(client, vc, single, { member, textChannel: queue.textChannel, selfDeaf: true, skip: false }));
            client.logger.log(`[AutoDJ] G:${guildId} añadida ${single} (1ª de la lista ${url}, ${Date.now() - t0}ms)`);
            addedMeta.set(single, meta);
          } else {
            seenMark(seen, url);
            AutoDjSource.markUsed(client, guildId, url);
            client.logger.warn(`[AutoDJ] G:${guildId} ${url} es lista/set y no se pudo aislar su 1ª canción: se descarta`);
          }
          continue;
        }
        const t0 = Date.now();
        // Pre-validar con yt-dlp (rápido y con tope: mata el proceso si se cuelga)
        // ANTES de meterle el URL a DisTube. Un play() de DisTube con una
        // extracción lenta/colgada queda SERIALIZADO y congela la transición y
        // la siguiente (y eso es lo que hacía que el bot se "saliera" al activar
        // el AutoDJ: watchdog 90s -> destruir conexión). Si yt-dlp no lo verifica
        // en 12s, la candidata se descarta y JAMÁS llega a distube.play().
        //
        // Las validaciones están SERIALIZADAS (una de yt-dlp a la vez), así que
        // esta esperita turno detrás del NextValidator, que es el que protege la
        // canción que REALMENTE va a sonar. Por eso el tope es corto y se
        // reutiliza el veredicto cacheado cuando la URL ya salió "ok".
        const cachedOk = _nextValidated.get(`${guildId}|${cleanUrl}`);
        const probe =
          cachedOk && Date.now() - cachedOk < NEXT_VALIDATE_TTL
            ? cleanUrl
            : await probeSingleURL(cleanUrl, 12000); // oEmbed (instantáneo); yt-dlp solo si no es concluyente
        const single = probe && isSafeSingle(probe) ? cleanYtUrl(probe) : null;
        if (single && excludedCanon.has(canonUrlKey(single))) {
          seenMark(seen, url);
          AutoDjSource.markUsed(client, guildId, url);
          client.logger.warn(`[AutoDJ] G:${guildId} ${single} (resuelto de ${url}) está baneada con 🚫: se descarta`);
          continue;
        }
        if (!single) {
          seenMark(seen, url);
          AutoDjSource.markUsed(client, guildId, url);
          client.logger.warn(`[AutoDJ] G:${guildId} ${url} no se pudo pre-validar (yt-dlp / no es single): se descarta`);
          continue;
        }
        await enqueueBot(queue, single, meta, () =>
          enqueueSong(client, vc, single, { member, textChannel: queue.textChannel, selfDeaf: true, skip: false }));
        client.logger.log(`[AutoDJ] G:${guildId} añadida ${single} (${Date.now() - t0}ms) · ${AutoDjOrder.infoOf(meta.type).icon} ${meta.type}${meta.userId ? ":" + meta.userId : ""}${meta.fallback ? " [" + meta.fallback + "]" : ""}`);
        addedMeta.set(single, meta);
      } catch (e) {
        if (/timeout/i.test(e?.message || "")) {
          // Se marca como usada para que el próximo refill NO vuelva a elegir la
          // misma URL que se cuelga.
          seenMark(seen, url);
          AutoDjSource.markUsed(client, guildId, url);
          client.logger.warn(`[AutoDJ] G:${guildId} ${url} tardó >60s en resolver, se abandona`);
        } else {
          client.logger.error(`[AutoDJ] No se pudo añadir favorita ${url}:`, e?.message || e);
        }
      }
    }
    if (!addedMeta.size) return 0;

    // Si un play() llegó a recrear una cola NUEVA (Stop/disconnect en medio):
    // deshacer ese playback fantasma YA mismo y no seguir tocando nada.
    const q = client.distube.getQueue(guildId) || queue;
    if (q !== originalQueue) {
      try { await q.stop().catch(() => {}); } catch (e) {}
      try { await client.distube.voices.leave(vc?.guild).catch(() => {}); } catch (e) {}
      client.logger.log(`[AutoDJ] G:${guildId} se deshizo una cola recreada por el refill tras un stop`);
      return 0;
    }
    // Si se canceló JUSTO DESPUÉS del último play (stop/off en el medio), no
    // intercalar ni actualizar nada: el toggle-off ya limpia las sobras.
    if (isCancelled()) return addedMeta.size;
    // Armar el bloque EN EL ORDEN DEL PATRÓN (rec, 🎲, rec, 🎲…) y dejarlo justo
    // después de la que suena. Las recién encoladas con play() están al final de
    // la cola; las movidas ya se sacaron de su lugar.
    const blockSongs = [];
    for (const item of block) {
      // Para listas aisladas la url que QUEDÓ en la cola es la del single.
      const url = item.playUrl || item.track.url;
      if (!addedMeta.has(url)) continue;
      const meta = addedMeta.get(url);
      const song = q.songs.find((x, i) => i > 0 && x && (x.url === url || canonUrlKey(x.url) === canonUrlKey(url)));
      if (!song) continue;
      // Red de seguridad: normalmente ya se marcó en addSong / al mover.
      flagBotSong(q, song, meta, !item.existing);
      blockSongs.push(song);
    }
    if (blockSongs.length) {
      relayoutQueue(q);
      // Pre-resolver el stream de las próximas en segundo plano (evita 5-15 s de
      // silencio en la transición).
      try { client.warmStreamURLs?.(q, 3); } catch (e) {}
      const _by = {};
      for (const m of addedMeta.values()) _by[m.type] = (_by[m.type] || 0) + 1;
      client.logger.log(
        `[AutoDJ] +${addedMeta.size} (${Object.entries(_by).map(([t, n]) => `${n}×${AutoDjOrder.infoOf(t).icon}${t}`).join(" ")}) · ciclo ` +
        `${pattern.map((p) => stepShort(p)).join(" > ")} · cola ${q.songs.length}`
      );
    }
    // Solo se marca lo que el AutoDJ eligió (no contaminar el historial con los
    // 300+ temas de una playlist que el usuario puso a mano).
    seenTrim(seen, new Set(q.songs.map((s) => s?.url).filter(Boolean)));

    // Persistir para no repetir entre sesiones.
    try { await PlaylistStore.saveAutoDjSeen(client, guildId, seen); } catch (e) {}

    client.autoDjReport = client.autoDjReport || new Map();
    const nRec = [...addedMeta.values()].filter((m) => m.type !== "random").length;
    const nRnd = [...addedMeta.values()].filter((m) => m.type === "random").length;
    client.autoDjReport.set(guildId, { total: addedMeta.size, rec: nRec, random: nRnd, pattern: [...pattern] });

    try { client.updatequeue(q).catch(() => {}); } catch (e) {}
    try { client.updateplayer(q).catch(() => {}); } catch (e) {}
    return addedMeta.size;
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
    console.log(`[DisTube] Playing: ${song.name} in${queue.textChannel.guild.name}`);

    // Identificador del gremio unificado
    const gid = queue.textChannel?.guildId || queue.guildId || queue.textChannel?.guild?.id || queue.guild?.id;

    // Conteo único y seguro de la reproducción
    if (gid && song?.url) {
      try {
        await PlaylistStore.countPlay(client, gid, song.url);
      } catch (err) {
        if (client?.logger?.error) {
          client.logger.error(`[PlaySong Stats Error] No se pudo contar reproducción para "${song.name}": ${err.message}`);
        } else {
          console.error(`[PlaySong Stats Error]`, err);
        }
      }
      // Reproducciones EN ESTA SESIÓN (en memoria): se usan en el log de
      // decisiones del AutoDJ para distinguir temas ya repetidos en la sesión.
      try {
        if (!(client._sessionPlays instanceof Map)) client._sessionPlays = new Map();
        let sp = client._sessionPlays.get(gid);
        if (!sp) { sp = new Map(); client._sessionPlays.set(gid, sp); }
        const ck = canonUrlKey(song.url);
        sp.set(ck, (sp.get(ck) || 0) + 1);
      } catch (_) {}
    }

    // Qué está SONANDO de verdad (lo emite DisTube en el voice). Se usa para
    // detectar desfases con queue.songs[0] (que el autodj / reorden tocan a mano).
    if (!client.actualPlaying) client.actualPlaying = new Map();
    client.actualPlaying.set(gid, {
      name: song.name,
      url: song.url,
      elapsed: Date.now(),
      autodj: !!song.autoDj,
      requestedBy: song.user?.id || null,
      thumbnail: song.thumbnail || null,
      uploader: song.uploader?.name || null,
      duration: Number(song.duration) || 0,
      formattedDuration: song.formattedDuration || null,
    });
    // Ya hay una canción sonando: el flag de "la anterior terminó" se limpia.
    try { queue._endedSongUrl = null; } catch (e) {}
    // Canción nueva: descartar la última posición capturada de la anterior.
    client._voiceLastPos?.delete(gid);

    // Reloj corregido para esta guild + reinicia el desfase (tema nuevo).
patchClock(queue, gid);
    resetClockDrift(gid);
    applyNormalizeDefault(queue, gid);
      // Pre-resolver las siguientes canciones: hace que el skip sea instantáneo.
    client.warmStreamURLs?.(queue, 3);
    instrumentVoice(queue);

    // Diagnóstico de transición: cuánto silencio hubo entre el player idle
    // (fin de canción) y este playSong. Un gap grande = la cola se quedó pegada.
    // El watchdog reactiva la cola con un skip() si el idle duró >45s; acá se
    // desarma ese timer y se mide el silencio real.
    if (!client._voiceIdleAt) client._voiceIdleAt = new Map();
    if (!client._voiceStallTimers) client._voiceStallTimers = new Map();
    {
      const stallT = client._voiceStallTimers.get(gid);
      if (stallT) { clearTimeout(stallT); client._voiceStallTimers.delete(gid); }
      const unstickT = client._voiceUnstickTimers?.get(gid);
      if (unstickT) { clearTimeout(unstickT); client._voiceUnstickTimers.delete(gid); }
      const idleAt = client._voiceIdleAt.get(gid);
      if (idleAt) {
        const gapMs = Date.now() - idleAt;
        if (gapMs > 15000) {
          client.logger.warn(
            `[Transition ${gid}] ${queue.textChannel.guild.name}:${Math.round(gapMs / 1000)}s de silencio antes de "${song.name}". ` +
            (client.autoDj?.get(gid)
              ? "(AutoDJ activo: un play() colgado/resolución lenta pudo bloquear la transición)"
              : "(causa a investigar)")
          );
        }
        client._voiceIdleAt.delete(gid);
      }
    }

    // Lo que suena ya "se usó": la 🎲 del AutoDJ no lo vuelve a sacar de la lista
    // y el loader no lo encola otra vez.
    AutoDjSource.markUsed(client, gid, song.url);

    queue._playSeq = (queue._playSeq || 0) + 1;

    // DJ constante: a cada canción que empieza, la cola se reabastece sola en
    // el fondo mientras Auto DJ siga activo (según el patrón configurado).
    if (client.autoDj?.get(gid)) {
      const qLive = client.distube.getQueue(gid) || queue;
      client.autoDjRefill(qLive).catch(() => {});
    }

    // Pre-calienta el stream de los PRÓXIMOS temas mientras suena el actual.
    // DisTube solo resuelve la URL del stream (yt-dlp) cuando el tema está por
    // arrancar: entre canción y canción eso paga 10-20s de silencio cada vez.
    // Resolverlo con anticipación deja la transición en ~1s (solo ffmpeg).
    (async () => {
      try {
        const lq = client.distube.getQueue(gid) || queue;
        const warm1 = lq.songs?.[1];
        const warm2 = lq.songs?.[2];
        if (warm1 && warm1 !== song) await client.distube.handler?.attachStreamInfo(warm1);
        if (warm2 && warm2 !== warm1) await client.distube.handler?.attachStreamInfo(warm2);
      } catch (e) {
        // El tema real se resolverá igual al tocarle el turno; no romper nada.
      }
    })();

// Las canciones del AutoDJ NO son pedidos del oyente (antes se registraban a su
    // nombre y contaminaban sus "pedidas": el AutoDJ terminaba "pidiéndose" a sí mismo).
    if (song.user?.id && !(song.autoDj || song._autoDj)) {
    MusicTracker.logPlay(gid, song.user.id, song);
    UserRequests.recordRequest(client, gid, song.user.id, song).catch(() => {});
    }

    // El audioPlayer se recrea en cada reconexión: hay que reaplicarle la
    // tolerancia a cortes cada vez que arranca una canción.
    hardenAudioPlayer((client.distube.getQueue(gid) || queue)?.voice);

    // Identidad de la canción REALMENTE en emisión. El `audioResource` de
    // DisTube v5 se crea sin `metadata` (`distube/dist/index.js:1847`), así que
    // el resource no sabe qué canción es, y para cuando salta el evento `idle`
    // `queue.songs[0]` ya puede ser la SIGUIENTE (jump() hace splice ANTES de
    // parar el player, línea 1061). Se guarda aquí, donde `song` sí es el
    // correcto, para poder distinguir "el stream murió a medias" de "el usuario
    // pidió skip".
    if (!client._voiceCurrent) client._voiceCurrent = new Map();
    client._voiceCurrent.set(gid, {
      url: song.url || null,
      name: song.name || null,
      duration: Math.round(Number(song.duration) || 0),
      startedAt: Date.now(),
    });

    const activityText = song.uploader?.name
      ? `${song.name} -${song.uploader.name}`
      : song.name;
    startMarqueeActivity(client, activityText, queue.textChannel.guild);

    if (!queue._sessionSaved && queue.songs.length === 1 && !queue._sessionSourcePlaylist) {
      const session = createSession(queue, "song", song.name, song.url, song.user, [song]);
      await saveSession(client, gid, session);
      queue._sessionSaved = true;
    }

    // Realinear la cola SIEMPRE que DisTube emite una canción distinta a songs[0].
    // Un skip() ejecutado durante una transición (idle) adelanta el índice interno
    // de DisTube SIN colapsar songs[], dejando canciones "fantasma" adelante y el
    // embed/dashboard mostrando una canción que NO suena. Aquí movemos la canción
    // REAL al frente para que todo (embeds, cola, dashboard, siguientes transiciones)
    // quede consistente de inmediato.
    if (song && song.url && queue.songs?.length > 1) {
      const cur0 = queue.songs[0];
      if (cur0?.url && cur0.url !== song.url) {
        const realIdx = queue.songs.findIndex((s, i) => i > 0 && s?.url === song.url);
        if (realIdx > 0) {
          const [realSong] = queue.songs.splice(realIdx, 1);
          queue.songs.unshift(realSong);
          client.logger.log(
            `[QueueSync ${gid}] songs[0]=${cur0.name} != ${song.name}; realineado${realIdx}->0.`
          );
        }
      }
    }

    // Fire-and-forget the request-channel/player updates so they never delay
    // the start of the next song. updateplayer recibe `song` (el real) para no
    // depender de songs[0] si quedó desfasado.
    client.updatequeue(queue).catch(() => {});
    client.updateplayer(queue, song).catch(() => {});
    // Validar la SIGUIENTE canción mientras suena (evita transiciones que
    // cuelgan a DisTube con canciones que su extractor no puede resolver).
    scheduleNextValidation(client, queue);

    // Los edits del embed fijo corren en paralelo (updatequeue/updateplayer +
    // el refill del AutoDJ) y, al llegar a Discord fuera de orden, pueden dejar
    // el panel con la canción ANTERIOR. Este re-render diferido (~1.5s) hace de
    // "latest wins": garantiza que el embed muestre SIEMPRE la canción actual y
    // deja en el log la confirmación ([EmbedSync]) para poder verificarlo.
    setTimeout(() => {
      (async () => {
        try {
          const lq = client.distube.getQueue(gid) || queue;
          if (!lq || !lq.songs?.length) return;
          const actual = client.actualPlaying?.get(gid) || song;
          await client.updateplayer(lq, actual);
          client.logger.log(
            `[EmbedSync ${gid}] panel sincronizado a "${actual?.name || actual?.url}".`
          );
        } catch (e) {}
      })();
    }, 1500);

    let data = await client.music.get(`${gid}.music`);
    if (data && data.channel === queue.textChannel.id) return;

    // Delete the previous "now playing" message before sending a fresh one
    const prevId = client.temp.get(gid);
    if (prevId) {
      try {
        const prevMsg = await queue.textChannel.messages.fetch(prevId).catch(() => null);
        if (prevMsg && !prevMsg.deleted) await prevMsg.delete().catch(() => {});
      } catch (e) {}
    }

    let statsValue = null;
    if (song.url) {
      try {
        const stats = await PlaylistStore.getGlobalTrackStats(client, gid, song.url)
          .catch(() => ({ likes: 0, dislikes: 0, plays: 0, skips: 0, favorites: 0, favoriteBy: [], likedBy: [], dislikedBy: [] }));
        const statsParts = [];
        if (stats.likes > 0) statsParts.push(`👍${stats.likes}`);
        if (stats.dislikes > 0) statsParts.push(`👎${stats.dislikes}`);
        if (stats.plays > 0) statsParts.push(`🔥${stats.plays}`);
        if (stats.favorites > 0) statsParts.push(`⭐${stats.favorites}`);
        if (stats.skips > 0) {
          const SW = Math.max(0, Number(process.env.AUTODJ_SKIP_WEIGHT) || 2);
          statsParts.push(`⏭${stats.skips} (🎲~${Math.round(100 / (1 + SW * stats.skips))}%)`);
        }
        const likeNames = (stats.likedBy || []).length ? `\n👍 Likes: ${stats.likedBy.join(", ")}` : "";
        const dislikeNames = (stats.dislikedBy || []).length ? `\n👎 Dislikes: ${stats.dislikedBy.join(", ")}` : "";
        const favNames = (stats.favoriteBy || []).length ? `\n⭐ Favoritos: ${stats.favoriteBy.join(", ")}` : "";
        statsValue = stats.likes > 0 || stats.dislikes > 0 || stats.plays > 0 || stats.skips > 0 || stats.favorites > 0
          ? `${statsParts.join(" · ")}${likeNames}${dislikeNames}${favNames}`
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
        client.temp.set(gid, msg.id);
      });
  });

  client.distube.on("addSong", async (queue, song) => {
    console.log(`[DisTube] Song Added: ${song.name}`);

    // ¿La puso el BOT (AutoDJ)? Se marca YA (síncrono, antes de cualquier await) y se
    // acomoda en su lugar del ciclo. Así NO entra al "Queue Priority" de abajo, que
    // es solo para pedidos de personas. Si la puso el loader de una lista, se anota
    // como "de la lista cargada" (📋) para distinguirla de un pedido manual (🙋).
    const _gidAdd = queue.textChannel?.guildId || queue.guildId;
    const _botMeta = client._autoDjPending?.get(`${_gidAdd}|${canonUrlKey(song.url)}`);
    if (_botMeta) {
      flagBotSong(queue, song, _botMeta, true);
      try { relayoutQueue(queue); } catch (e) { client.logger.error(`[AutoDJ] relayout:`, e?.message || e); }
    } else if (AutoDjSource.takeListExpect(client, _gidAdd, song.url)) {
      song._fromList = true;
    }
    const _isBotSong = !!(song.autoDj || song._autoDj);

    // Peticiones de otras personas al inicio de la cola (orden de llegada)
    const ownerId = process.env.OWNER_ID;
    if (!_isBotSong && isOtherRequester(song.user, ownerId) && queue.songs.length > 1) {
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
    // Si lo recién agregado quedó como songs[1], validarlo ya (evita que una
    // adición a mitad de canción deje una "siguiente" que cuelgue la transición).
    scheduleNextValidation(client, queue);

    const _head = queue.songs.slice(0, 3).map((s) => s?.name || "?").join(" | ");
    client.logger.log(`[addSong] "${song.name}" -> head: ${_head} (len ${queue.songs.length})`);

    // Las favoritas se llenan SOLO a mano (comando guardar/like). Ya NO se
    // auto-guardan canciones al reproducirse, aunque las haya pedido otro
    // usuario o el AutoDJ: evita que "pongan favorito a una canción y se
    // agregue toda la lista". countPlay (línea 289) solo cuenta reproducciones
    // de canciones QUE YA ESTÁN en favoritas, no agrega nada nuevo.

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

      // Desconexión PROGRAMADA del watchdog de voz (conexión atascada): no es
      // algo que el usuario haya hecho, así que no se le avisa ni se manda el
      // rejoin automático por acá (el rescate ya va a reconectar solo).
      if (client._voiceRecovering?.get(guildId)) {
        client.logger.log(
          `[Disconnect] Guild ${guildId}: desconexión del watchdog de voz; la restores el rescate en curso.`
        );
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

        // Sin timer propio: lo borra el auto-borrado global a los 10s.
        await queue.textChannel.send({ embeds: [embed] });
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
      const url = song?.url || queue?.songs?.[0]?.url;

      // Auto-retry: el stream de YouTube a veces muere por throttle momentáneo.
      // Volvemos a reproducir el MISMO tema con un stream fresco (yt-dlp re-resuelve)
      // hasta 2 veces en 30 segundos; si sigue fallando, se salta como antes.
      if (queue && url) {
        if (!client.ffmpegRetry) client.ffmpegRetry = new Map();
        const st = client.ffmpegRetry.get(url) || { n: 0, ts: 0 };
        if (Date.now() - st.ts > 30000) st.n = 0;
        st.ts = Date.now();
        if (st.n < 2) {
          st.n += 1;
          client.ffmpegRetry.set(url, st);
          const vc = queue.voice?.connection?.channel || queue.textChannel?.guild?.members?.me?.voice?.channel;
          if (vc && vc.members) {
            try {
              client.logger.error(
                `[FFMPEG_EXITED] Reintentando (${st.n}/2) la canción ${trackName} con un stream nuevo... ` +
                `(si persiste, regenera las cookies del navegador: npm run export-cookies)`
              );
              // Reconstruye el stream del MISMO tema, reanudando donde se cortó
              // (posición oída guardada) en vez de desde 0.
              //
              // Antes usaba `distube.play(vc, url, { skip: true })`: eso mete la
              // canción en la posición 1 de la cola y ejecuta `queue.skip()`, así
              // que el reintento no reproducía la canción rota sino la SIGUIENTE
              // de la cola (en logs.txt: se anunciaba el reintento de "Ojalá nos
              // perdonen" y empezó "Soda Stereo" 60 ms después).
              // `queue.seek()` vuelve a resolver el stream (yt-dlp) y reproduce
              // la canción que YA está en cabeza, sin tocar el resto de la cola.
              const fgid = queue?.textChannel?.guildId || queue?.id;
              const ffResume = resumeSecondsFor(fgid, url, 2);
              await withTimeout(queue.seek(ffResume), 15000, "reintento ffmpeg");
              return;
            } catch (e) {
              client.logger.error(`[FFMPEG_EXITED] El reintento de ${trackName} también falló:`, e?.message || e);
            }
          }
          client.ffmpegRetry.delete(url);
        } else {
          client.ffmpegRetry.delete(url);
        }
      }

      // Contador de fallos del stream. Si insiste (varios reintentos en la
      // misma hora), el stream se aparta 12h del AutoDJ: asi deja de colarse
      // y de hacer saltar "2s y siguiente" de forma repetida.
      const murio = noteStreamFailure(url);

      client.logger.error(
        `[FFMPEG_EXITED] La reproducción de la canción ${trackName} se interrumpió tras varios intentos. ` +
        (morio
          ? `El stream de esta canción está muerto repetidamente: se aparta del AutoDJ por 12h. `
          : `Causa probable: el stream fue throttled/cortado o el proceso de ffmpeg falló. `) +
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
    // Sin catch: si el send falla (permisos, canal borrado) el rechazo terminaba
    // como UnhandledRejection. El borrado lo hace el auto-borrado global
    // (options.ephemeralTTL, 10s); acá no se manda un timer propio.
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
      .catch(() => {});
  });

  client.distube.on("noRelated", async (queue) => {
    // songs[0] puede no existir (la cola se vació justo antes del evento):
    // `queue?.songs[0].name` reventaba con TypeError.
    if (!queue?.textChannel) return;
    queue.textChannel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setTitle(`No Related Song Found for \`${queue.songs?.[0]?.name || "?"}\``),
        ],
      })
      .catch(() => {});
  });

  client.distube.on("finishSong", async (queue, song) => {
    // Fire-and-forget so the next song starts immediately (these do heavy DB/network work)
    client.editPlayerMessage(queue.textChannel).catch(() => {});
    // La canción que terminó: el panel la usa para saber que lo que suena
    // AHORA es la siguiente (songs[0]) y no esperar a que DisTube termine de
    // resolver el stream (10-20 s) para actualizar el CURRENT TRACK.
    try { queue._endedSongUrl = song?.url || null; } catch (e) {}
    client.updatequeue(queue).catch(() => {});
    client.updateplayer(queue).catch(() => {});

    // NO tocar actualPlaying acá: lo único que confirma qué canción emite es
    // playSong. Si lo "avanzamos" nosotros, el diagnóstico miente.
    // (La canción real la verá la snapshot al cruzar playSong con queue.songs).
  });

  client.distube.on("finish", async (queue) => {
    if (client.actualPlaying) client.actualPlaying.delete(queue.textChannel?.guildId || queue.id);
    stopMarqueeActivity(client, queue.textChannel.guild);
    // La cola terminó: no armar el watchdog (ya no hay más canciones).
    const fgid = queue.textChannel?.guildId || queue.id;
    if (client._voiceStallTimers) { const st = client._voiceStallTimers.get(fgid); if (st) { clearTimeout(st); client._voiceStallTimers.delete(fgid); } }
    if (client._voiceUnstickTimers) { const ut = client._voiceUnstickTimers.get(fgid); if (ut) { clearTimeout(ut); client._voiceUnstickTimers.delete(fgid); } }
    if (client._voiceConnTimers) { const ct = client._voiceConnTimers.get(fgid); if (ct) { clearTimeout(ct); client._voiceConnTimers.delete(fgid); } }
    if (client._voiceIdleAt) client._voiceIdleAt.delete(fgid);
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
      .catch(() => {});
  });

  // ---- Tolerancia a cortes de audio --------------------------------------
  //
  // @discordjs/voice para el player a los 100 ms sin audio
  // (`maxMissedFrames: 5`, default de `createAudioPlayer`, y DisTube lo crea
  // sin options: `distube/dist/index.js:304`). Con 100 ms de margen, un hipo de
  // ffmpeg mataba el player y se oía un corte de ~1 s. Con 50 (1 s) el player
  // aguanta el hipo, inserta el silencio y sigue solo, sin cortar la canción.
  const MAX_MISSED_FRAMES = Math.max(5, Number(process.env.VOICE_MAX_MISSED_FRAMES) || 50);
  const hardenAudioPlayer = (voice) => {
    try {
      const p = voice?.audioPlayer;
      if (!p?.behaviors) return false;
      if (p.behaviors.maxMissedFrames >= MAX_MISSED_FRAMES) return false;
      const prev = p.behaviors.maxMissedFrames;
      p.behaviors.maxMissedFrames = MAX_MISSED_FRAMES;
      client.logger.log(
        `[Voice] maxMissedFrames ${prev} -> ${MAX_MISSED_FRAMES}: el player tolera cortes de ~1s ` +
        `en vez de detenerse al primer hipo de ffmpeg.`
      );
      return true;
    } catch {
      return false;
    }
  };

  // ---- Reloj de posición corregido ----------------------------------------
  //
  // El `playbackDuration` de @discordjs/voice cuenta PAQUETES PREPARADOS, no
  // audio ESCUCHADO: cuando el stream no entrega a tiempo el player inserta
  // SILENCIO y suma igual, y cuando el event loop va cargado el ciclo global de
  // audio se auto-recupera leyendo paquetes de golpe. Resultado: el reloj se
  // adelanta al oído (el audio queda en el buffer de Discord) y `currentTime`
  // va 1-2s por DELANTE del audio real. Todo `seek()` que use ese reloj
  // (autoresume, botones del dashboard, watchdog) reanuda más adelante de donde
  // realmente se oye.
  //
  // Acá se mide esa deriva y se corrige el reloj: `client._clockDrift` guarda,
  // por guild, cuántos segundos va adelantado el reloj crudo. El getter
  // `currentTime` de cada queue se parchea a nivel de instancia para devolver el
  // reloj MENOS esa deriva, así TODOS los consumidores usan la posición real sin
  // tocar cada llamada. Se resetea al empezar cada tema y en cada seek (un
  // stream nuevo arranca con el reloj ya correcto).
  if (!client._clockDrift) client._clockDrift = new Map();

  const newDriftState = () => ({ offset: 0, pos: null, rawStart: null, wallStart: 0, samples: [] });
  const driftEntry = (gid) => {
    let e = client._clockDrift.get(gid);
    if (!e) { e = newDriftState(); client._clockDrift.set(gid, e); }
    return e;
  };
  const resetClockDrift = (gid) => {
    if (!gid) return;
    client._clockDrift.set(gid, newDriftState());
  };
  const clockOffset = (gid) => Number(client._clockDrift.get(gid)?.offset) || 0;

  // Parchea la instancia del queue: `currentTime` resta la deriva y `seek`
  // reinicia el desfase (el stream nuevo arranca con reloj limpio).
  const patchClock = (queue, gid) => {
    if (!queue || !gid || queue._jvdClockPatched) return;
    const proto = Object.getPrototypeOf(queue);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "currentTime");
    if (!desc || typeof desc.get !== "function") return;
    queue._jvdClockPatched = true;
    Object.defineProperty(queue, "currentTime", {
      configurable: true,
      get() {
        const raw = Number(desc.get.call(this)) || 0;
        const dur = Number(this.songs?.[0]?.duration) || 0;
        let v = raw - clockOffset(gid);
        if (v < 0) v = 0;
        if (dur > 0 && v > dur) v = dur;
        return v;
      },
    });
    if (typeof queue.seek === "function" && !queue._jvdSeekPatched) {
      const origSeek = queue.seek;
      queue._jvdSeekPatched = true;
      queue.seek = function (time) {
        resetClockDrift(gid);
        return origSeek.call(this, time);
      };
    }
    // `play(false)` también reinicia el stream (FilterManager#apply setea
    // `_beginTime = currentTime` y llama `play(false)`): hay que limpiar la
    // deriva ahí también o el reloj quedaría restando dos veces.
    if (typeof queue.play === "function" && !queue._jvdPlayPatched) {
      const origPlay = queue.play;
      queue._jvdPlayPatched = true;
      queue.play = function (...args) {
        resetClockDrift(gid);
        return origPlay.apply(this, args);
      };
    }
  };

  // Segundos donde reanudar un tema cortado, según la última posición OÍDA
  // guardada. Retrocede `backstep` segundos para no re-enganchar justo en el
  // frame muerto que causó el corte.
  const resumeSecondsFor = (gid, url, backstep = 2) => {
    const last = client._voiceLastPos?.get(gid);
    if (!last || !url || last.url !== url) return 0;
    const sec = (Number(last.ms) || 0) / 1000;
    if (!(sec > 5)) return 0;
    return Math.max(0, sec - backstep);
  };

  // Asegura que el filtro de normalización de volumen coincida con la
  // preferencia del guild (`${guildId}.volumenormalize`, por defecto ON). Se
  // llama en cada playSong; solo actúa cuando el estado no coincide (add/remove
  // dispara un reinicio de stream, por eso no se toca si ya está bien).
  const applyNormalizeDefault = async (queue, gid) => {
    if (!queue || !gid || !queue.filters) return;
    try {
      let enabled = await client.music?.get(`${gid}.volumenormalize`);
      if (enabled === undefined || enabled === null) enabled = true;
      const has = queue.filters.has("normalize");
      if (enabled && !has) queue.filters.add("normalize");
      else if (!enabled && has) queue.filters.remove("normalize");
    } catch (e) {
      client.logger?.warn?.(`[Normalize] no se pudo aplicar en G:${gid}: ${e?.message || e}`);
    }
  };

  const startClockDriftProbe = () => {
    if (client._clockDriftProbe) return;
    client._clockDriftProbe = true;
    const warnedAt = new Map();
    // La sonda mide el adelanto ACUMULADO del reloj crudo contra el reloj de
    // pared desde un ancla, y se queda con el MÍNIMO de las últimas muestras.
    // Así el ruido de ráfagas (un micro-bloqueo atrasa el reloj y luego se
    // recupera de golpe: adelanto transitorio de ±1-2s que se cancela solo) da
    // ~0, y solo una ventaja PERSISTENTE se descuenta. (La versión anterior
    // sumaba cada ráfaga positiva e ignoraba las negativas: el ruido se volvía
    // una rampa de ~25s/min y las reanudaciones retrocedían la canción.)
    const WINDOW = 20;      // muestras (1 por segundo)
    const MIN_SAMPLES = 10; // no corregir antes de tener historia
    const MAX_OFFSET = 3;   // tope de seguridad (s)
    const t = setInterval(() => {
      // OJO: `distube.queues` es un QueueManager (BaseManager), NO un Map: sus
      // colas viven en `.collection` (una Collection de discord.js).
      const queues = client.distube?.queues?.collection;
      if (!queues) return;
      try {
        for (const q of queues.values()) {
          const gid = q?.textChannel?.guildId || q?.guild?.id;
          if (!gid) continue;
          const e = driftEntry(gid);
          // Pausa / sin reproducir: la pared sigue corriendo y el reloj no.
          // Re-anclar al volver para no medir la pausa como deriva negativa.
          if (!q.playing || q.paused) { e.pos = null; e.rawStart = null; e.samples = []; continue; }
          // Reloj CRUDO: `q.voice.playbackTime` NO está parcheado (a diferencia
          // de `q.currentTime`, que ya devuelve el valor corregido).
          const raw = Number(q.voice?.playbackTime) || 0;
          const now = Date.now();
          if (e.pos == null || e.rawStart == null) {
            e.pos = raw; e.rawStart = raw; e.wallStart = now; e.samples = [];
            continue;
          }
          const delta = raw - e.pos;
          e.pos = raw;
          // Retroceso o salto grande = seek/cambio de stream: re-ancla.
          if (delta < -0.5 || delta > 15) {
            e.rawStart = raw; e.wallStart = now; e.samples = []; e.offset = 0;
            continue;
          }
          const lead = (raw - e.rawStart) - (now - e.wallStart) / 1000;
          e.samples.push(lead);
          if (e.samples.length > WINDOW) e.samples.shift();
          const persistent = e.samples.length >= MIN_SAMPLES ? Math.min(...e.samples) : 0;
          e.offset = Math.max(0, Math.min(persistent, MAX_OFFSET));
          if (e.offset > 0.5 && now - (warnedAt.get(gid) || 0) > 60000) {
            warnedAt.set(gid, now);
            client.logger.warn(
              `[AudioDrift] G:${gid} el reloj va ${e.offset.toFixed(2)}s por DELANTE de forma sostenida ` +
              `en "${q.songs?.[0]?.name || "?"}" (pos=${raw.toFixed(1)}s). Se corrige el reloj.`
            );
          }
        }
      } catch (e) {
        if (Date.now() - (warnedAt.get("__probe") || 0) > 60000) {
          warnedAt.set("__probe", Date.now());
          client.logger.warn(
            `[AudioDrift] sonda de deriva falló: ${e?.message || e}`
          );
        }
      }
    }, 1000);
    if (typeof t.unref === "function") t.unref();
  };
  startClockDriftProbe();

  // ---- Voice / DAVE / player diagnostics (one-time per guild) ----
    const instrumentVoice = (queue) => {
      const guildId = queue.textChannel?.guildId || queue.guildId;
      const voice = queue.voice;
      if (!voice) return;
      const conn = voice.connection;

      // Se engancha por CONEXIÓN (no por Voice): si el bot cambia de canal de
      // voz o DisTube reemplaza la conexión, esa es la que hay que vigilar. Este
      // bloque va ANTES del guard de audioPlayer para que una conexión nueva
      // quede vigilada aunque el Voice ya esté instrumentado.
      if (conn && voice._jvdConn !== conn) {
        voice._jvdConn = conn;
        conn.on("stateChange", (oldState, newState) => {
          client.logger.log(`[VoiceDiag ${guildId}] conn ${oldState.status} -> ${newState.status}`);
          const st = newState?.status;
          if (st === "connecting" || st === "signalling" || st === "disconnected") armConnWatchdog(guildId, conn, queue);
          else {
            // ready = todo bien (se limpia el backoff); destroyed = la cola se
            // está cerrando y no hay nada que vigilar.
            clearConnWatchdog(guildId);
            if (st === "ready") client._voiceRecoverFails?.delete(guildId);
          }
        });
        conn.on("debug", (msg) => client.logger.log(`[VoiceDiag ${guildId}] DBG ${String(msg).slice(0, 400)}`));
      }
      if (voice._jvdDiag) return;
      voice._jvdDiag = true;
      hardenAudioPlayer(voice);
      if (voice.audioPlayer) {
        voice.audioPlayer.on("stateChange", (oldState, newState) => {
          const status = newState.status;
          if (status === "idle" || status === "playing" || status === "buffering" || status === "autopaused") {
            // El `audioResource` de DisTube v5 se crea SIN `metadata`
            // (`distube/dist/index.js:1847`: solo `inputType` e
            // `inlineVolume`), así que `resource.metadata` siempre es undefined
            // y no sirve para identificar el tema. La identidad viene de
            // `_voiceCurrent`, que se llena en playSong con la canción buena.
            const cur = client._voiceCurrent?.get(guildId) || null;
            const resName = (() => {
              const played = Math.round((oldState.resource?.playbackDuration || 0) / 1000);
              if (status !== "idle") return null;
              return `"${cur?.name || "?"}" (emitidos ${played}s de ${cur?.duration || "?"}s)`;
            })();
            client.logger.log(
              `[VoiceDiag ${guildId}] player ${oldState.status} -> ${status}` +
              (resName ? ` :: ${resName}` : "") +
              ` :: missed=${newState.missedFrames ?? oldState.missedFrames ?? 0}` +
              (status === "idle" && newState.reason ? ` :: reason=${newState.reason}` : "")
            );
            // Un "idle" momentáneo (hipo de red al recargar el resource) puede
            // volver a "playing" SIN que empiece otra canción (no hay playSong
            // que limpie nada). Si el watchdog se dejara armado, dispararía a los
            // 45s y REINICIARÍA una canción que venía sonando bien. Al volver a
            // reproducir se cancela la vigilancia y se descarta el "idle".
            if (status === "playing") {
              const stallT = client._voiceStallTimers?.get(guildId);
              if (stallT) { clearTimeout(stallT); client._voiceStallTimers.delete(guildId); }
              const unstickT = client._voiceUnstickTimers?.get(guildId);
              if (unstickT) { clearTimeout(unstickT); client._voiceUnstickTimers.delete(guildId); }
              client._voiceIdleAt?.delete(guildId);
            }
            // ¿La canción TERMINÓ o se CORTÓ antes de tiempo? Si el audio se
            // emite menos de lo que dura la canción, el oyente pierde el final y
            // para él "la canción se adelantó". Se mide con el reloj del propio
            // player contra la duración declarada del tema.
            //
            // Solo se avisa si la canción que murió SIGUE siendo la actual: en un
            // skip manual `songs[0]` ya es la siguiente, y comparar la del
            // resource contra la siguiente daba un falso "faltaron N segundos"
            // en cada skip.
            if (status === "idle" && cur?.duration) {
              try {
                const played = Math.round((oldState.resource?.playbackDuration || 0) / 1000);
                const lq0 = client.distube.getQueue(guildId);
                const s0 = lq0?.songs?.[0];
                const stillCurrent =
                  !!s0 &&
                  ((cur.url && (s0.url === cur.url || s0.name === cur.name)) ||
                    (!cur.url && s0.name === cur.name));
                const dur = cur.duration;
                if (stillCurrent && played > 3 && dur > played + 3) {
                  client.logger.warn(
                    `[AudioTrunc] G:${guildId} "${cur.name}" emitió ${played}s de ${dur}s: ` +
                    `faltaron ${dur - played}s de audio (motivo=${newState.reason || "?"}, missed=${oldState.missedFrames ?? 0}).`
                  );
                }
              } catch (e) {
                client.logger.warn(`[AudioTrunc] no se pudo medir el corte: ${e?.message || e}`);
              }
            }
            // `autopaused` = el player NO tiene ninguna conexión "playable" (la de
            // voz se cayó). El watchdog también tiene que cubrirlo: si solo mira
            // `idle`, una conexión muerta deja al bot mudo indefinidamente sin
            // logs ni ningún intento de recuperación.
            if (status === "idle" || status === "autopaused") {
              // Watchdog anti-PEG: si el player quedó idle con canciones por sonar,
              // el siguiente playSong desarma estos timers. Escalones RÁPIDOS para
              // no dejar cortado al usuario, SIN saltar la canción que estaba
              // sonando:
              //   20s  → si se cortó A MITAD: reintenta LA MISMA reanudando en
              //          la posición donde se cortó (NO se pierde la cola); si
              //          ya terminó (transición colgada) o ya se reintentó y
              //          volvió a caer: skip()
              //   +30s → si sigue idle: otro reintento reanudando; si no
              //          alcanza, skip().
              //          NUNCA se destruye la conexión: no debe desconectar.
              if (!client._voiceStallTimers) client._voiceStallTimers = new Map();
              if (!client._voiceIdleAt) client._voiceIdleAt = new Map();
              if (!client._voiceUnstickTimers) client._voiceUnstickTimers = new Map();
              client._voiceIdleAt.set(guildId, Date.now());
              // Guardar la posición REAL al momento de caer: `oldState.resource`
              // venía reproduciendo y trae `playbackDuration` en ms. Es la única
              // pista fiable para saber si la canción TERMINÓ (transición
              // colgada) o se CORTÓ a mitad, porque después del idle el resource
              // se borra y `lq.currentTime` vuelve a 0.
              try {
                const posMs = oldState?.resource?.playbackDuration;
                if (Number.isFinite(posMs)) {
                  if (!client._voiceLastPos) client._voiceLastPos = new Map();
                  const curUrl = client.distube.getQueue(guildId)?.songs?.[0]?.url
                    || client.actualPlaying?.get(guildId)?.url || null;
                  // Guardamos la posición OÍDA (no la del reloj crudo, que va
                  // adelantado): restamos el desfase acumulado para reanudar
                  // exactamente donde se cortó.
                  const correctedMs = Math.max(0, posMs - clockOffset(guildId) * 1000);
                  const prev = client._voiceLastPos.get(guildId);
                  if (!prev || prev.url !== curUrl || correctedMs > (Number(prev.ms) || 0)) {
                    client._voiceLastPos.set(guildId, { url: curUrl, ms: correctedMs });
                  }
                }
              } catch {}
              const prevStall = client._voiceStallTimers.get(guildId);
              if (prevStall) clearTimeout(prevStall);
              const prevUnstick = client._voiceUnstickTimers.get(guildId);
              if (prevUnstick) { clearTimeout(prevUnstick); client._voiceUnstickTimers.delete(guildId); }
              // Detecta si la canción actual se cortó A MITAD (stream muerto:
              // el usuario la estaba escuchando y NO quiere que se la salten)
              // o si terminó de verdad (transición colgada a la siguiente).
              // ----------------------------------------------------------------
              //  Rescate de una cola COLGADA (esto era lo que mataba el audio).
              //
              //  DisTube serializa skip/seek/jump/play detrás de `_taskQueue`:
              //  cada operación espera la promesa de la anterior (ver
              //  TaskQueue.queuing en node_modules/distube). Si una tarea se
              //  cuelga —típico en playSong, que hace `await attachStreamInfo`
              //  y se queda esperando a yt-dlp— esa promesa NO resuelve nunca,
              //  `remaining` queda en 1 para siempre y TODO lo que se pida
              //  después espera indefinidamente.
              //
              //  Por eso el watchdog podía loguear "Saltando" y no pasar nada:
              //  el skip esperaba la promesa colgada, songs[0] seguía siendo la
              //  misma canción y el bot se quedaba mudo hasta el escalón de
              //  90s (que sí lo arreglaba, pero tras un silencio larguísimo).
              // ----------------------------------------------------------------

              // resolve() es público y saca UNA tarea por llamada, así que
              // drenar la cola colgada es seguro y no toca node_modules.
              const drainTaskQueue = (lq) => {
                let n = 0;
                try {
                  const tq = lq?._taskQueue;
                  const pend = Number(tq?.remaining) || 0;
                  for (let i = 0; i < pend; i++) {
                    tq.resolve();
                    n++;
                  }
                } catch (e) {
                  // Si drain falla, la `_taskQueue` sigue colgada y TODO lo que
                  // se pida después (skip, seek, play) espera para siempre: el
                  // bot queda mudo. Esto no puede fallar en silencio.
                  client.logger.warn(
                    `[Voice] no se pudo drenar la _taskQueue (quedaban ${pend ?? "?"}): ${e?.message || e}`
                  );
                }
                return n;
              };

              // Mata el stream colgado para no dejar ffmpeg huérfano.
              const killStuckStream = (lq) => {
                try { lq?.voice?.stream?.kill?.(); } catch {}
              };

              // Drena + fuerza la reproducción de songs[0]. Se usa cuando la misma pista
              // ya se reintentó y no hay forma de "saltar" porque el skip también
              // cuelga.
              const forcePlay = async (lq) => {
                const drenadas = drainTaskQueue(lq);
                killStuckStream(lq);
                if (!lq?.songs?.length) return { drenadas, ok: false };
                try {
                  if (lq.stopped === true) return { drenadas, ok: false };
                  lq.playing = true;
                  await Promise.race([
                    lq.play(),
                    new Promise((r) => setTimeout(() => r(null), 10000)),
                  ]);
                  return { drenadas, ok: true };
                } catch {
                  return { drenadas, ok: false };
                }
              };

              const stallStatus = (lq) => {
                const cur = lq.songs[0];
                const dur = cur && Number(cur.duration) > 0 ? Number(cur.duration) : 0;
                // `lq.currentTime` VIENE EN SEGUNDOS (Distube Voice#playbackTime,
                // index.js:887) → acá se pasa a ms. Antes se usaba como ms: el
                // umbral `dur*1000` nunca se alcanzaba, `ended` SIEMPRE daba
                // false y el log mostraba "sonó 0s" → el watchdog reiniciaba
                // canciones que ya habían terminado. Además, al caer a idle el
                // resource se borra y currentTime queda en 0, así que se usa la
                // última posición real capturada (_voiceLastPos).
                const last = client._voiceLastPos?.get(guildId);
                const lastMs = last && last.url === cur?.url ? Number(last.ms) || 0 : 0;
                const nowMs = Math.max(
                  Number.isFinite(lq.currentTime) ? Math.max(0, lq.currentTime) * 1000 : 0,
                  lastMs
                );
                const ended = dur > 0 && nowMs >= dur * 1000 * 0.92;
                return { cur, next: lq.songs[1], dur, nowMs, ended };
              };
              // Reintenta reproducir la canción ACTUAL sin recrear la cola:
              // seek() reusa la cola existente (songs[0]) y solo reinicia el
              // stream. NO se usa stop(): Queue.stop() llama a remove() y BORRA
              // toda la cola (index.js:1155-1176) → eso era lo que la colapsaba
              // a "len 1" y disparaba la desconexión.
              const replayTrack = async (lq, target, phase) => {
                const vc = lq.voice?.channel;
                if (!vc || !target?.url || !lq.voice?.connection) return false;
                const cur = lq.songs?.[0];
                // seek() solo reproduce songs[0]; si el target no es la actual
                // no forzamos nada (evita saltos raros).
                if (!cur || cur.url !== target.url) return false;
                // Reanudar donde se cortó (posición OÍDA guardada), no desde 0.
                const resumeAt = resumeSecondsFor(guildId, target.url, 2);
                try {
                  client.logger.warn(
                    `[QueueWatchdog ${guildId}] ${phase}: reintentando "${target.name || target.url}" SIN desconectar ` +
                    `(reanudando en ${resumeAt.toFixed(1)}s, la cola se conserva).`
                  );
                  await withTimeout(lq.seek(resumeAt), 15000, "seek replay watchdog");
                  // seek() no emite playSong: refrescamos la fuente de verdad y
                  // el panel a mano para no quedar desincronizados.
                  if (!client.actualPlaying) client.actualPlaying = new Map();
                  client.actualPlaying.set(guildId, {
                    name: cur.name,
                    url: cur.url,
                    elapsed: Date.now(),
                    autodj: !!cur.autoDj,
                    requestedBy: cur.user?.id || null,
                    thumbnail: cur.thumbnail || null,
                    uploader: cur.uploader?.name || null,
                    duration: Number(cur.duration) || 0,
                    formattedDuration: cur.formattedDuration || null,
                  });
                  // Nuevo intento en curso: la posición previa ya no aplica.
                  client._voiceLastPos?.delete(guildId);
                  client.updateplayer?.(lq, lq.songs[0]).catch(() => {});
                  client.updatequeue?.(lq).catch(() => {});
                  client._voiceIdleAt?.delete(guildId);
                  client._voiceUnstickTimers.delete(guildId);
                  client._voiceStallTimers?.delete(guildId);
                  client.logger.log(
                    `[QueueWatchdog ${guildId}] recuperado: reproduciendo "${target.name || target.url}" (cola intacta, ${lq.songs.length} canciones).`
                  );
                  return true;
                } catch (e) {
                  client.logger.warn(`[QueueWatchdog ${guildId}] ${phase}: reanudar en ${Math.round(resumeSecondsFor(guildId, target.url))}s no alcanzó (${e?.message || e}); queda el siguiente escalón.`);
                  return false;
                }
              };
              const forceUnstick = () => {
                if (!client._voiceUnstickTimers?.has(guildId)) return;
                const lq = client.distube.getQueue(guildId);
                if (!lq || !lq.songs?.length) return;
                // Conexión de voz caída: reconectar (seek/arranque no pueden
                // hacer nada si no hay por dónde emitir audio).
                const connStatus = lq.voice?.connection?.state?.status;
                if (connStatus && connStatus !== "ready" && connStatus !== "destroyed") {
                  client._voiceUnstickTimers.delete(guildId);
                  client._voiceIdleAt?.delete(guildId);
                  recoverVoice(guildId, lq, `PEG: la conexión de voz quedó en "${connStatus}"`);
                  return;
                }
                // Solo la canción ACTUAL (seek reproduce songs[0]): así nunca se
                // salta nada ni se recrea la cola.
                const target = lq.songs[0];
                replayTrack(lq, target, "PEG 50s").then(async (ok) => {
                  if (ok) return;
                  // Último recurso: saltar a la siguiente. JAMÁS se destruye la
                  // conexión (el bot no debe desconectarse de voz).
                  client.logger.warn(
                    `[QueueWatchdog ${guildId}] PEG 50s: reanudar no alcanzó; forzando la cola (drenar + play, sin desconectar).`
                  );
                  client._voiceIdleAt?.delete(guildId);
                  client._voiceUnstickTimers.delete(guildId);
                  if (!lq.songs?.length) return;
                  // Antes acá se hacía un skip más: con la cola de tareas
                  // colgada ese skip también esperaba para siempre y el bot
                  // quedaba mudo hasta el corte de 90s. Ahora se drena y se
                  // fuerza la reproducción de verdad.
                  forcePlay(lq).then((r) => {
                    if (r.ok) {
                      client.logger.warn(
                        `[QueueWatchdog ${guildId}] recuperada: sonando "${lq.songs[0]?.name || "?"}" (${r.drenadas} tarea(s) drenadas).`
                      );
                    } else {
                      client.logger.error(
                        `[QueueWatchdog ${guildId}] no se pudo forzar la cola (${r.drenadas} drenadas); queda el escalón de corte.`
                      );
                    }
                  });
                });
              };
              const t = setTimeout(async () => {
                if (!client._voiceStallTimers?.has(guildId)) return;
                const lq = client.distube.getQueue(guildId);
                if (!lq || !lq.songs?.length) return;
                const idleSince = client._voiceIdleAt?.get(guildId);
                if (!idleSince) return;
                client._voiceStallTimers.delete(guildId);
                // Seguro extra: si al vencer el plazo el player YA está
                // reproduciendo (blip idle->playing cuyo evento se perdió, o
                // simplemente ya no está idle), NO hay PEG: reiniciar acá
                // cortaría una canción que suena bien. Se descarta el marcador.
                const playerStatus = lq.voice?.audioPlayer?.state?.status;
                if (playerStatus === "playing") {
                  client._voiceIdleAt?.delete(guildId);
                  return;
                }
                const idleFor = Date.now() - idleSince;
                const { cur, next, dur, nowMs, ended } = stallStatus(lq);
                if (!cur?.url) return;
                // Si la CONEXIÓN de voz es la que está caída, el problema no es la
                // cola: ni seek(0) ni skip() sirven (no hay por dónde sonar). Se
                // reconecta; al volver a "ready" el player retoma solo.
                const connStatus = lq.voice?.connection?.state?.status;
                if (connStatus && connStatus !== "ready" && connStatus !== "destroyed") {
                  recoverVoice(guildId, lq, `player en "${status}" con la conexión en "${connStatus}"`);
                  return;
                }
                // Reset del marcador de reintento si ya cambió la canción.
                if (lq._stallReplayUrl && lq._stallReplayUrl !== cur.url) lq._stallReplayUrl = null;
                if (ended) {
                  // La canción TERMINÓ: JAMÁS se reintenta (sería repetirla).
                  // Si hay siguiente, forzamos la transición que quedó colgada;
                  // si no, se deja terminar (autoplay / fin de cola).
                  lq._stallReplayUrl = null;
                  if (next?.url) {
                    // La transición quedó colgada. Un skip a secas puede quedar
                    // esperando la promesa de la tarea que se colgó, así que
                    // primero se drena la cola de tareas: recién ahí el skip
                    // avanza de verdad. Sin esto el log decía "Saltando",
                    // songs[0] no cambiaba y sonaba el mismo tema una y otra vez.
                    const objetivo = cur.url;
                    const drenadas = drainTaskQueue(lq);
                    if (drenadas > 0) {
                      client.logger.warn(
                        `[QueueWatchdog ${guildId}] la cola de tareas de DisTube tenía ${drenadas} operación(es) colgada(s); drenadas para poder avanzar.`
                      );
                    }
                    // Drenar DESBLOQUEA la transición que DisTube tenía a medias, y
                    // esa transición ya avanza la cola por su cuenta. Si nos saltamos
                    // encima, la canción se saltaba sola: se perdía la que iba a
                    // sonar. Por eso se espera un margen (para que la continuación de
                    // DisTube corra de verdad) y se re-valida DESPUÉS del drenaje:
                    // solo se salta si songs[0] sigue siendo la misma.
                    await new Promise((r) => setTimeout(r, STALL_DRAIN_GRACE_MS));
                    const ahora = lq.songs?.[0];
                    if (ahora?.url !== objetivo) {
                      client.logger.log(
                        `[QueueWatchdog ${guildId}] el drenaje dejó avanzar la cola sola a "${ahora?.name || ahora?.url || "?"}"; no se salta de más.`
                      );
                      return;
                    }
                    client.logger.warn(
                      `[QueueWatchdog ${guildId}] PEG ${Math.round(idleFor / 1000)}s: "${cur.name || cur.url}" terminó y la transición a la siguiente quedó colgada. Saltando (no se pierde nada).`
                    );
                    lq.skip().catch(() => {});
                  } else {
                    client.logger.log(
                      `[QueueWatchdog ${guildId}] PEG ${Math.round(idleFor / 1000)}s: "${cur.name || cur.url}" terminó (sin siguiente en cola); no se reintenta.`
                    );
                  }
                } else if (!lq._stallReplayUrl) {
                  // La canción se CORTÓ a mitad (el usuario la estaba
                  // escuchando): se REINTENTA la misma, no se la salta.
                  client.logger.warn(
                    dur > 0
                      ? `[QueueWatchdog ${guildId}] PEG ${Math.round(idleFor / 1000)}s: "${cur.name || cur.url}" se cortó a mitad (sonó ${Math.round(nowMs / 1000)}s de ${Math.round(dur)}s). Reintentando la MISMA canción sin saltarla.`
                      : `[QueueWatchdog ${guildId}] PEG ${Math.round(idleFor / 1000)}s: "${cur.name || cur.url}" quedó en silencio. Reintentando la MISMA canción sin saltarla.`
                  );
                  lq._stallReplayUrl = cur.url;
                  replayTrack(lq, cur, "PEG 20s").catch(() => {});
                } else {
                  // Ya se reintentó esta canción y volvió a cortarse: recién
                  // acá se la salta (no quedarse en loop si la URL está rota).
                  lq._stallReplayUrl = null;
                  // Misma guarda que en el caso "terminó": si la cola ya avanzó
                  // sola mientras tanto, saltar ahora perdería la canción actual.
                  if (lq.songs?.[0]?.url !== cur.url) {
                    client.logger.log(
                      `[QueueWatchdog ${guildId}] la cola ya avanzó a "${lq.songs?.[0]?.name || "?"}"; no se salta de más.`
                    );
                    return;
                  }
                  client.logger.warn(
                    `[QueueWatchdog ${guildId}] PEG ${Math.round(idleFor / 1000)}s: "${cur.name || cur.url}" volvió a cortarse tras el reintento. Saltando para no quedarse en silencio.`
                  );
                  lq.skip().catch(() => {});
                }
                // 2º escalón: si en 30s más sigue idle, recuperación (mismo
                // canal; si DisTube está serializado, corte + reconexión).
                const t2 = setTimeout(forceUnstick, STALL_2ND_MS);
                client._voiceUnstickTimers.set(guildId, t2);
              }, STALL_1ST_MS);
              client._voiceStallTimers.set(guildId, t);
            }
          }
        });
        voice.audioPlayer.on("error", (e) => client.logger.error(`[VoiceDiag ${guildId}] player error: ${e.message}`));
        voice.audioPlayer.on("debug", (msg) => client.logger.log(`[VoiceDiag ${guildId}] PDBG ${String(msg).slice(0, 200)}`));
      }
    };

    // ffmpeg escupe una línea por evento y DisTube las reenvía como
    // `[<guildId>] [ffmpeg] log: <linea>`. El filtro anterior buscaba el patrón
    // de progreso ANCLADO al principio (`^size=`), así que NUNCA casaba con el
    // prefijo real: se loguearon 229.722 líneas (33 MB de logs.txt) y cada una
    // abría/escribía/cerraba el archivo en el event loop. Ahora se busca el
    // patrón dentro de la línea y, además, se limita a 1 línea cada 5s por guild.
    const FFMPEG_NOISE =
      /size=\s*\d|time=\s*-?[\d:]|bitrate=|speed=|fps=\s*[\d.]|frame=\s*\d|out_time=|dropping |dup_frames|config=|built with|Stream mapping|lib(av|swscale|postproc)|^\s*$/i;
    const FFMPEG_SPAWN = /spawn ffmpeg|ffmpeg-static|path\]/i;
    const FFMPEG_LOG_MIN_GAP_MS = 5000;
    client.distube.on("ffmpegDebug", (guildId, data) => {
      const line = String(data ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
      if (!line) return;
      if (FFMPEG_SPAWN.test(line)) return;
      if (FFMPEG_NOISE.test(line)) return;
      if (!client._ffmpegLogAt) client._ffmpegLogAt = new Map();
      const last = client._ffmpegLogAt.get(guildId) || 0;
      const now = Date.now();
      if (now - last < FFMPEG_LOG_MIN_GAP_MS) return;
      client._ffmpegLogAt.set(guildId, now);
      client.logger.log(`[FFMPEG ${guildId}] ${line.slice(0, 300)}`);
    });

    client.distube.on("initQueue", async (queue) => {
    queue.volume = client.config.options.defaultVolume;

    // Reset Auto DJ to off by default on every new play session.
    // El Auto DJ NUNCA se reactiva solo: solo arranca si el usuario lo pidió
    // explícitamente (autoDjIntent=true) y sigue apagado si lo apagó, aunque la
    // cola se reinicie por errores/Stop (antes se re-enableaba solo y parecía
    // que los controles de skip/pausa "no hacían caso" tras quitar el AutoDJ).
    const guildId = queue.textChannel?.guildId || queue.guildId;
    AutoDjSource.resetUnlessLoading(client, guildId);
    if (client.autoDjIntent?.get(guildId) === true) {
      client.autoDj?.set(guildId, true);
    } else {
      client.autoDj?.delete(guildId);
      client.autoDjPrev?.delete(guildId);
      client.autoDjBusy?.delete(guildId);
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
      .catch(() => {});
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
      .catch(() => {});
  });
};