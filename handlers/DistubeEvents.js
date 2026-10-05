const { EmbedBuilder, Events } = require("discord.js");
const { entersState, VoiceConnectionStatus } = require("@discordjs/voice");
const MusicBot = require("./Client");
const AutoresumeHandler = require("./AutoresumeHandler");
const InitAutoResume = require("./InitAutoresume");
const UserHistory = require("./UserHistory");
const MusicTracker = require("./MusicTracker");
const PlaylistStore = require("./PlaylistStore");
const AutoDjSource = require("./Autodjsource");
const { fetchPlaylistFirstURL, validateSinglePlayable, isPlaylistURL } = require("./PlaylistFetcher");
const { isAgeGateError, friendlyPlaybackError } = require("./PlaybackError");
const { startMarqueeActivity, stopMarqueeActivity } = require("./ActivityManager");

const MAX_SESSION_SONGS = 150;

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
      await withTimeout(
        client.distube.play(vc, pick.url, {
          member: pick.user || null,
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

    // Patrón de intercalado (dashboard / comando): [rec:user, random, ...].
    const pattern =
      (await PlaylistStore.getAutoDjPattern(client, guildId).catch(() => null)) ||
      PlaylistStore.DEFAULT_AUTODJ_PATTERN;

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
        }).filter((u) => !excludedCanon.has(canonUrlKey(u)));
        if (cand.length) {
          const url = pickLeastPlayed(cand, (u) => skipWeight(u, "*"), playsOfUrl);
          taken.add(url);
          dbgLine(`🎲 random: candidatas=${cand.length} -> ${url} (skips oyentes=${skipCountOf(url, "*")})`);
          return { url, name: null, existing: inQueue.has(url), fromList: true };
        }
        dbgLine(`🎲 random: candidatas=${cand.length} -> SIN (lista agotada, cae a favoritas)`);
      }
      // Una PLAYLIST no puede ser candidata de rec (el pool trae URLs de listas
      // del historial: recomendarlas = "revivir otra lista", y la 1ª canción
      // aislada de esa lista es la que el usuario ve reaparecer como "no
      // relacionada"). Además SOLO entran candidatas que resuelven RÁPIDO como
      // single (isSafeSingle): los sets de SoundCloud hicieron que un play()
      // colgara 45-60s por candidata.
      const isSafeCand = (t) => t?.url && !isPlaylistURL(t.url) && isSafeSingle(t.url);
      let pool;
      if (step.type === "rec" && step.userId && step.userId !== "*") {
        const own = (poolsByUser[step.userId] || []).filter((t) => isSafeCand(t));
        const ownUrls = new Set(own.map((t) => t.url));
        const scratch = (historyByUser.get(step.userId) || []).filter((t) => isSafeCand(t) && !ownUrls.has(t.url));
        const ownHist = scratch.slice(0, REC_HISTORY_MAX).filter((t) => t?.url);
        // REC PARA UN USUARIO = SOLO lo que le gusta escuchar: sus favoritas
        // ordenadas por score (likes×10 + reproducciones) y su historial.
        // NO se meten "picks" (1ras canciones de listas ajenas) ni historial de
        // otros: por eso "Psalm 135" (primera de OTRA lista, sin un solo like) no
        // debe volver a recomendarse.
        // El score además descuenta los SKIPS de ESE usuario: no desaparece del
        // pool (si es su única favorita sigue sonando), pero cae en la lista.
        const score = (t) => ((t.likedBy || []).length - (t.dislikedBy || []).length) * 10 + (t.playCount || 0) - SKIP_WEIGHT * skipCountOf(t.url, step.userId);
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
      const weightOf = (t) => skipWeight(t.url, step.userId);
      const isUsableNow = (t) => t?.url && !excludedCanon.has(canonUrlKey(t.url)) && !nearQueue.has(t.url);
      const freshOf = (arr) => arr.filter((t) => isUsableNow(t) && !seen.has(t.url) && !taken.has(t.url));
      // Tres escalones, en orden. Antes el paso 3 (reciclar) saltaba siempre al
      // final porque pickUnseen nunca devolvía null, y encima elegía SIEMPRE la
      // primera de la lista: por eso se repetían las mismas 2-3 canciones.
      let found = null;
      let usedFallback = false;
      // 1) Alguna favorita REAL sin ver → la normal, nunca se repite.
      const freshReal = freshOf(pool);
      if (freshReal.length) {
        found = pickLeastPlayed(freshReal, weightOf);
      } else if (ALLOW_UNLIKED) {
        // 2) El pool REAL ya se vio entero → Favoritas SIN 👍 (nunca con 👎).
        //    Con un pool real chico esto es lo que evita el reciclado constante:
        //    las candidatas pasan de 24 a 84.
        const fbFresh = freshOf(Object.values(fallbackPools).flat().filter(isSafeCand));
        if (fbFresh.length) {
          found = pickLeastPlayed(fbFresh, weightOf);
          usedFallback = true;
        }
      }
      // 3) No queda nada sin ver: se recyclinga (olvida la mitad más vieja).
      if (!found) found = pickUnseen(pool, seen, excludedCanon, nearQueue, weightOf);
      if (found && !taken.has(found.url)) {
        taken.add(found.url);
        found.existing = inQueue.has(found.url);
        dbgLine(
          `🛸 rec: ${tag}` +
          ` skips=${skipCountOf(found.url, step.userId)}` +
          ` -> ${found.url}${found.fromList ? " (lista)" : ""}` +
          `${usedFallback ? " [sin 👍 → rescate]" : ""}` +
          `${found.existing ? " [ya en cola→se adelanta]" : " [nueva→play()]"}`
        );
        return found;
      }
      dbgLine(`🛸 rec: ${tag} -> SIN (descartadas por seen/excl/taken/near)`);
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
            : await fetchPlaylistFirstURL(cleanUrl, { timeoutMs: 12000 });
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
        await withTimeout(
          client.distube.play(vc, single, { member, textChannel: queue.textChannel, selfDeaf: true, skip: false }),
          45000,
          url
        );
        client.logger.log(`[AutoDJ] G:${guildId} añadida ${single} (${Date.now() - t0}ms)`);
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
    // Canción nueva: descartar la última posición capturada de la anterior.
    client._voiceLastPos?.delete(gid);

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

    if (song.user?.id) {
      MusicTracker.logPlay(gid, song.user.id, song);
    }

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
        client.temp.set(gid, msg.id);
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
      if (voice.audioPlayer) {
        voice.audioPlayer.on("stateChange", (oldState, newState) => {
          const status = newState.status;
          if (status === "idle" || status === "playing" || status === "buffering" || status === "autopaused") {
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
            // `autopaused` = el player NO tiene ninguna conexión "playable" (la de
            // voz se cayó). El watchdog también tiene que cubrirlo: si solo mira
            // `idle`, una conexión muerta deja al bot mudo indefinidamente sin
            // logs ni ningún intento de recuperación.
            if (status === "idle" || status === "autopaused") {
              // Watchdog anti-PEG: si el player quedó idle con canciones por sonar,
              // el siguiente playSong desarma estos timers. Escalones RÁPIDOS para
              // no dejar cortado al usuario, SIN saltar la canción que estaba
              // sonando:
              //   20s  → si se cortó A MITAD: reintenta LA MISMA con seek(0)
              //          (NO se pierde la cola); si ya terminó (transición
              //          colgada) o ya se reintentó y volvió a caer: skip()
              //   +30s → si sigue idle: otro seek(0); si no alcanza, skip().
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
                  const prev = client._voiceLastPos.get(guildId);
                  if (!prev || prev.url !== curUrl || posMs > (Number(prev.ms) || 0)) {
                    client._voiceLastPos.set(guildId, { url: curUrl, ms: posMs });
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
                } catch {}
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
              // seek(0) reusa la cola existente (songs[0]) y solo reinicia el
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
                try {
                  client.logger.warn(
                    `[QueueWatchdog ${guildId}] ${phase}: reintentando "${target.name || target.url}" SIN desconectar (seek 0, la cola se conserva).`
                  );
                  await withTimeout(lq.seek(0), 15000, "seek 0 watchdog");
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
                  client.logger.warn(`[QueueWatchdog ${guildId}] ${phase}: seek 0 no alcanzó (${e?.message || e}); queda el siguiente escalón.`);
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
                    `[QueueWatchdog ${guildId}] PEG 50s: seek 0 no alcanzó; forzando la cola (drenar + play, sin desconectar).`
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