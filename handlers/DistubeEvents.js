const { EmbedBuilder, Events } = require("discord.js");
const MusicBot = require("./Client");
const AutoresumeHandler = require("./AutoresumeHandler");
const InitAutoResume = require("./InitAutoresume");
const UserHistory = require("./UserHistory");
const MusicTracker = require("./MusicTracker");
const PlaylistStore = require("./PlaylistStore");
const AutoDjSource = require("./Autodjsource");
const { fetchPlaylistFirstURL } = require("./PlaylistFetcher");
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

  /**
   * Elige una favorita que aún no se haya puesto. Si ya se agotaron TODAS las
   * candidatas, olvida la mitad más vieja de "lo visto" (menos lo que está en
   * cola) para que las favoritas vuelvan a entrar en rotación.
   * `blocked` = urls que NO podemos usar ahora (ya en la cola y próximas a
   * sonar / la que está sonando). Las favoritas en `blocked` no se tocan; las
   * que están en la cola pero LEJOS se pueden usar: luego se "adelantan" al
   * hueco del AutoDJ sin duplicarse (el loader salta las usadas).
   */
  const pickUnseen = (pool, seen, excluded, blocked) => {
    const usable = pool.filter((t) => t?.url && !excluded.has(t.url) && !blocked.has(t.url));
    if (!usable.length) return null;
    const fresh = usable.find((t) => !seen.has(t.url));
    if (fresh) return fresh;
    let drop = Math.max(1, Math.floor(seen.size / 2));
    for (const k of [...seen.keys()]) {
      if (drop <= 0) break;
      if (blocked.has(k)) continue;
      seen.delete(k);
      drop--;
    }
    return usable.find((t) => !seen.has(t.url)) || usable[0];
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

    // Patrón de intercalado (dashboard / comando): [rec:user, random, ...].
    const pattern =
      (await PlaylistStore.getAutoDjPattern(client, guildId).catch(() => null)) ||
      PlaylistStore.DEFAULT_AUTODJ_PATTERN;

    // Exclusiones: lo que cada oyente pidió NO volver a escuchar con AutoDJ
    // (botón "🚫 No AutoDJ" / 2+ skips).
    const excludeData = await PlaylistStore.getAutodjExcludes(client, guildId).catch(() => ({}));
    const excludedUrls = new Set(Object.values(excludeData || {}).flat());

    // Pool POR USUARIO con solo favoritas reales (con 👍 o guardadas a mano ⭐).
    // Antes se usaba la lista entera: una versión vieja del bot guardaba ahí
    // automáticamente cada canción que sonaba y el AutoDJ metía temas que el
    // usuario nunca pidió.
    const poolsByUser = await PlaylistStore.getAutoDjPoolsByUser(client, guildId, listeners);
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

    const shuffleAny = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

    const allPool = Object.values(poolsByUser).flat().filter((t) => t?.url);

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

    const pickForStep = (step, taken, inQueue) => {
      // 🎲 → al azar entre TODAS las canciones de la lista ingresada que aún no
      // sonaron ni se eligieron (aunque el loader no las haya encolado todavía).
      // Sin reposición: cada una sale una sola vez por sesión. Si la lista ya no
      // tiene candidatas, cae al pool de favoritas/historial/picks de siempre.
      if (step.type === "random") {
        const cand = AutoDjSource.candidates(client, guildId, {
          excluded: excludedUrls,
          taken,
          currentUrl: queue.songs[0]?.url,
        });
        if (cand.length) {
          const url = cand[Math.floor(Math.random() * cand.length)];
          taken.add(url);
          dbgLine(`🎲 random: candidatas=${cand.length} -> ${url}`);
          return { url, name: null, existing: inQueue.has(url), fromList: true };
        }
        dbgLine(`🎲 random: candidatas=${cand.length} -> SIN (lista agotada, cae a favoritas)`);
      }
      let pool;
      if (step.type === "rec" && step.userId && step.userId !== "*") {
        const own = (poolsByUser[step.userId] || []).filter((t) => t?.url);
        const ownUrls = new Set(own.map((t) => t.url));
        const ownHist = (historyByUser.get(step.userId) || []).filter((t) => t?.url && !ownUrls.has(t.url));
        pool = shuffleAny([...own, ...ownHist, ...allPool.filter((t) => !ownUrls.has(t.url))]);
      } else {
        pool = shuffleAny(allPool);
      }
      // Historias de TODOS los oyentes de la llamada (lo que pidieron reproducir,
      // aunque sea de otras listas que ya no están en esta cola).
      if (allHistory.length) {
        const inPool = new Set(pool.map((t) => t?.url));
        const extra = allHistory.filter((t) => t?.url && !inPool.has(t.url));
        if (extra.length) pool = pool.concat(shuffleAny(extra));
      }
      if (picks.length) pool = pool.concat(shuffleAny(picks));

      // No recomendar lo que ya está en la cola y PRÓXIMO a sonar (ni la canción
      // que está sonando): se descartan los primeros ~REC_MIN_GAP de la lista.
      // Pero una favorita que quedó LEJOS en la cola (o que ya dejó de estar)
      // SÍ se usa: se "adelanta" al hueco del bot y el loader salta la usada,
      // así se recomiendan aunque sean pocas los likes y nunca se duplican.
      const nearQueue = new Set();
      for (const [i, s] of queue.songs.entries()) {
        if (s?.url && (i === 0 || i <= REC_MIN_GAP)) nearQueue.add(s.url);
      }
      const found = pickUnseen(pool, seen, excludedUrls, nearQueue);
      if (found && !taken.has(found.url)) {
        taken.add(found.url);
        found.existing = inQueue.has(found.url);
        dbgLine(
          `🛸 rec: pool=${pool.length} (favs=${allPool.length} hist=${allHistory.length} picks=${picks.length})` +
          ` near=${nearQueue.size} -> ${found.url}${found.fromList ? " (lista)" : ""}${found.existing ? " [ya en cola→se adelanta]" : " [nueva→play()]"}`
        );
        return found;
      }
      dbgLine(
        `🛸 rec: pool=${pool.length} (favs=${allPool.length} hist=${allHistory.length} picks=${picks.length})` +
        ` near=${nearQueue.size} -> SIN (descartadas por seen/excl/taken/near)`
      );
      return null;
    };

    // ---- Sumar siguiendo el patrón, intercalado EN MEDIO de la lista ----
    // Las canciones del bot viven en HUECOS fijos de la cola (índices 2, 5, 8…,
    // donde 1 = el primer tema que suena al rato), así entre cada dos del bot
    // quedan 1-2 temas de TU lista y el bot jamás se "roba" el turno ni se
    // amontona. Se mantienen LOOKAHEAD_CYCLES ciclos del patrón por delante y
    // SOLO se repone el hueco que queda vacío. Si la cola es corta, rellena con
    // al menos 1 para no quedarse en silencio.
    const LOOKAHEAD_CYCLES = Math.max(1, Number(process.env.AUTODJ_LOOKAHEAD_CYCLES) || 2);
    const targetBot = pattern.length * LOOKAHEAD_CYCLES;
    const upNext = queue.songs.length - 1;
    // Huecos objetivo (índices sobre toda la cola, 1 = el primero que sigue).
    const botSlots = Array.from({ length: targetBot }, (_, k) => 2 + k * 3);
    const occupiedBot = new Set();
    for (let i = 1; i < queue.songs.length; i++) {
      const s = queue.songs[i];
      if (s && (s.autoDj || s._autoDj)) occupiedBot.add(i);
    }
    // Huecos que faltan llenar. Tolerancia ±1: al ir sonando, las del bot avanzan
    // un puesto y siguen contando (no reinsertar de más mientras se consumen).
    const missingSlots = botSlots.filter(
      (p) => p < queue.songs.length && ![...occupiedBot].some((o) => o >= 1 && Math.abs(o - p) <= 1)
    );
    let toAdd = missingSlots.length;
    if (upNext < 4) {
      // Cola muy corta: rellena con 1, pero solo si NO hay ya una del bot
      // esperando (evita encadenar 🛸 seguidas mientras carga la lista).
      const botPending = queue.songs.slice(1).some((s) => s && (s.autoDj || s._autoDj));
      if (!botPending) toAdd = Math.max(toAdd, 1);
    }
    if (toAdd <= 0) return 0;

    const inQueue = new Set(queue.songs.map((s) => s?.url).filter(Boolean));
    const taken = new Set();
    const si = typeof queue._autoDjStep === "number" ? queue._autoDjStep : 0;
    const block = [];
    for (let i = 0; i < toAdd; i++) {
      const step = pattern[(si + i) % pattern.length];
      const pick = pickForStep(step, taken, inQueue);
      if (!pick) continue;
      seenMark(seen, pick.url);
      // Usada: el loader no la encola de nuevo y la 🎲 no la repite.
      AutoDjSource.markUsed(client, guildId, pick.url);
      block.push({ track: pick, step, existing: !!pick.existing });
      inQueue.add(pick.url);
    }
    if (!block.length) {
      client.logger.log(
        `[AutoDJ] G:${guildId} refill: patrón=${pattern.map((p) => (p.type === "random" ? "🎲" : `🛸:${p.userId}`)).join(">")}` +
        ` huecos=${botSlots.join(",")} faltan=${missingSlots.join(",")} toAdd=${toAdd} oyentes=${listeners.join(",")}`
      );
      for (const l of dbg) client.logger.log(`[AutoDJ] G:${guildId}   ${l}`);
      return 0;
    }
    queue._autoDjStep = (si + block.length) % pattern.length;
    client.logger.log(
      `[AutoDJ] G:${guildId} refill: patrón=${pattern.map((p) => (p.type === "random" ? "🎲" : `🛸:${p.userId}`)).join(">")}` +
      ` huecos=${botSlots.join(",")} faltan=${missingSlots.join(",")} toAdd=${toAdd} oyentes=${listeners.join(",")}`
    );
    for (const l of dbg) client.logger.log(`[AutoDJ] G:${guildId}   ${l}`);

    // Materializar como Song objects reales (DisTube necesita la resolución).
    // Para "rec de fulano" se usa el member de ESE usuario (la canción queda a
    // su nombre en la cola); para "random" el fallback es el que pidió la cola
    // o el bot. Se guarda de dónde vino cada una (tipo + usuario).
    const fallbackMember = queue.songs[0]?.member || vc?.guild?.members?.me;
    const addedMeta = new Map(); // url -> { type: "rec"|"random", userId }
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
      const isRecUser = step.type === "rec" && step.userId && step.userId !== "*";
      const meta = { type: step.type === "random" ? "random" : "rec", userId: isRecUser ? step.userId : null };
      let member = fallbackMember;
      if (isRecUser) {
        member = vc?.guild?.members?.cache?.get(meta.userId) || fallbackMember;
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
            item.playUrl = single;
            const t0 = Date.now();
            await withTimeout(
              client.distube.play(vc, single, { member, textChannel: queue.textChannel, selfDeaf: true, skip: false }),
              60000,
              `toca ${url} (1ª de la lista) -> ${single}`
            );
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
        await withTimeout(
          client.distube.play(vc, cleanUrl, { member, textChannel: queue.textChannel, selfDeaf: true, skip: false }),
          60000,
          url
        );
        client.logger.log(`[AutoDJ] G:${guildId} añadida ${cleanUrl} (${Date.now() - t0}ms)`);
        addedMeta.set(cleanUrl, meta);
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
      // Para listas aisladas la url que QUEDÓ en la cola es la del single
      // (item.playUrl), no la de la lista original.
      const url = item.playUrl || item.track.url;
      if (!addedMeta.has(url)) continue;
      let song = movedByUrl.get(url);
      if (!song) {
        const idx = q.songs.findIndex((x, i) => i > 0 && x?.url === url);
        if (idx > 0) [song] = q.songs.splice(idx, 1);
      }
      if (!song) continue;
      const meta = addedMeta.get(url);
      song.autoDj = true;
      song._autoDj = true;
      song.autoDjType = meta.type;
      song.autoDjUserId = meta.userId || null;
      blockSongs.push(song);
    }
    if (blockSongs.length) {
      // Se reparten en los HUECOS fijos (2, 5, 8…) para quedar entre medio de la
      // lista y nunca amontonadas ni robándole el turno a tus temas.
      let bi = 0;
      for (const slot of missingSlots) {
        if (bi >= blockSongs.length) break;
        q.songs.splice(Math.min(slot, q.songs.length), 0, blockSongs[bi++]);
      }
      // Sobrantes (cola muy corta sin hueco disponible): se paden al final para
      // no robarle el turno a los pocos temas que quedan por sonar.
      while (bi < blockSongs.length) {
        q.songs.push(blockSongs[bi++]);
      }
      // Sin urls repetidas en la cola (deja la primera aparición).
      const finalSeen = new Set();
      q.songs = q.songs.filter((x) => {
        if (!x?.url) return true;
        if (finalSeen.has(x.url)) return false;
        finalSeen.add(x.url);
        return true;
      });
      client.logger.log(
        `[AutoDJ] +${addedMeta.size} (${[...addedMeta.values()].filter((m) => m.type === "rec").length} 🛸 rec + ` +
        `${[...addedMeta.values()].filter((m) => m.type === "random").length} 🎲 aleatorias) · patrón ` +
        `${pattern.map((p) => (p.type === "random" ? "🎲" : `🛸:${p.userId}`)).join(" > ")} · cola ${q.songs.length}`
      );
    }
    // Solo se marca lo que el AutoDJ eligió (no contaminar el historial con los
    // 300+ temas de una playlist que el usuario puso a mano).
    seenTrim(seen, new Set(q.songs.map((s) => s?.url).filter(Boolean)));

    // Persistir para no repetir entre sesiones.
    try { await PlaylistStore.saveAutoDjSeen(client, guildId, seen); } catch (e) {}

    client.autoDjReport = client.autoDjReport || new Map();
    const nRec = [...addedMeta.values()].filter((m) => m.type === "rec").length;
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
      thumbnail: song.thumbnail || null,
      uploader: song.uploader?.name || null,
      duration: Number(song.duration) || 0,
      formattedDuration: song.formattedDuration || null,
    });

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
            `[Transition ${gid}] ${queue.textChannel.guild.name}: ${Math.round(gapMs / 1000)}s de silencio antes de "${song.name}". ` +
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
    if (client.autoDj?.get(queue.textChannel.guildId)) {
      const qLive = client.distube.getQueue(queue.textChannel.guildId) || queue;
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
              await client.distube.play(vc, url, {
                member: queue.songs?.[0]?.member || vc.guild?.members?.me,
                textChannel: queue.textChannel,
                selfDeaf: true,
                skip: true,
              });
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

      client.logger.error(
        `[FFMPEG_EXITED] La reproducción de la canción ${trackName} se interrumpió tras varios intentos. ` +
        `Causa probable: el stream de YouTube fue throttled/cortado (cookies viejas) o el proceso de ffmpeg falló. ` +
        `Regenerá las cookies frescas con "npm run export-cookies" en la PC del bot. ` +
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
    // La cola terminó: no armar el watchdog (ya no hay más canciones).
    const fgid = queue.textChannel?.guildId || queue.id;
    if (client._voiceStallTimers) { const st = client._voiceStallTimers.get(fgid); if (st) { clearTimeout(st); client._voiceStallTimers.delete(fgid); } }
    if (client._voiceUnstickTimers) { const ut = client._voiceUnstickTimers.get(fgid); if (ut) { clearTimeout(ut); client._voiceUnstickTimers.delete(fgid); } }
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
            if (status === "idle") {
              // Watchdog anti-PEG: si el player quedó idle con canciones por sonar
              // (transición colgada p.ej. por un play() lento), el siguiente
              // playSong desarma este timer; si NO llega en 45s, se fuerza skip.
              // Si el skip TAMPOCO basta (play() colgado serializa todos los
              // comandos de DisTube; skip incluido), hay un 2º escalón a los 90s
              // que destruye la conexión de voz: lo único que corta ese bloqueo.
              if (!client._voiceStallTimers) client._voiceStallTimers = new Map();
              if (!client._voiceIdleAt) client._voiceIdleAt = new Map();
              if (!client._voiceUnstickTimers) client._voiceUnstickTimers = new Map();
              client._voiceIdleAt.set(guildId, Date.now());
              const prevStall = client._voiceStallTimers.get(guildId);
              if (prevStall) clearTimeout(prevStall);
              const prevUnstick = client._voiceUnstickTimers.get(guildId);
              if (prevUnstick) { clearTimeout(prevUnstick); client._voiceUnstickTimers.delete(guildId); }
              const forceUnstick = () => {
                if (!client._voiceUnstickTimers?.has(guildId)) return;
                const lq = client.distube.getQueue(guildId);
                if (!lq || !lq.songs?.length) return;
                const idleSince = client._voiceIdleAt?.get(guildId);
                if (!idleSince) return;
                client.logger.warn(
                  `[QueueWatchdog ${guildId}] PEG 90s: el skip no alcanzó (play() colgado en DisTube). ` +
                  `Destruyendo la conexión de voz para destrabar (el AutoDJ/autoresume recolocará la cola).`
                );
                if (lq.voice?.connection) {
                  try { lq.voice.connection.destroy(); } catch (e) { client.logger.error(`[QueueWatchdog ${guildId}] destroy error: ${e.message}`); }
                }
                client._voiceUnstickTimers.delete(guildId);
              };
              const t = setTimeout(() => {
                if (!client._voiceStallTimers?.has(guildId)) return;
                const lq = client.distube.getQueue(guildId);
                if (!lq || !lq.songs?.length) return;
                const idleSince = client._voiceIdleAt?.get(guildId);
                if (!idleSince) return;
                client.logger.warn(
                  `[QueueWatchdog ${guildId}] PEG: player idle ${Math.round((Date.now() - idleSince) / 1000)}s con ${lq.songs.length} canción(es). ` +
                  `Siguiente: "${lq.songs[0]?.name || lq.songs[0]?.url}". Forzando skip para reactivar.`
                );
                lq.skip().catch(() => {});
                // 2º escalón: si en 45s más sigue idle, cortar la conexión.
                const t2 = setTimeout(forceUnstick, 45000);
                client._voiceUnstickTimers.set(guildId, t2);
              }, 45000);
              client._voiceStallTimers.set(guildId, t);
            }
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