const { fetchPlaylistFirstURL, fetchPlaylistURLsIncrementally, fetchPlaylistAllURLsFlat } = require("./PlaylistFetcher");
const AutoDjSource = require("./Autodjsource");
const { isUnavailableVideoError, friendlyUnavailableError } = require("./PlaybackError");

function log(client, guildId, msg) {
  const ts = new Date().toLocaleTimeString("es-ES", { hour12: false });
  const line = `[PlaylistLoader][${ts}] G:${guildId} ${msg}`;
  console.log(line);
  if (client.logger?.info) client.logger.info(line);
}

/**
 * Critical threshold: if the queue is this low, start shovelling the rest at
 * max speed so a song never ends with nothing loaded to follow it.
 */
const LOW_QUEUE_SAFETY = 5;

function queueCount(client, guildId) {
  try {
    return client.distube?.getQueue(guildId)?.songs?.length || 0;
  } catch {
    return 0;
  }
}

/**
 * Starts playback of a YouTube playlist as fast as possible:
 *  1) fetch ONLY the first URL (seconds) and play it immediately
 *  2) stream the rest from item 2 onward in batches, adaptively paced so the
 *     queue stays ahead of the currently playing song
 *  3) stops if /stop or the loading flag is cleared
 *
 * @param {object} params
 * @param {import("./Client")} params.client
 * @param {any} params.channel
 * @param {string} params.playlistUrl
 * @param {object} params.playOpts
 * @param {(msg: string) => Promise<void>|void} [params.onStatus] optional progress status (reply)
 * @returns {Promise<{ matchedCount: number, firstPlayed: boolean, urls: string[], skipped: string[] }>}
 */
async function streamPlaylist({ client, channel, playlistUrl, playOpts, onStatus }) {
  const guildId = channel.guild.id;
  const t0 = Date.now();

  // Clear any stale stop flag (e.g. set by a previous /stop or the Stop button)
  // so this new load is never cancelled the moment streaming starts.
  client.playlistStopped?.delete?.(guildId);

  log(client, guildId, `Iniciando carga de playlist: ${playlistUrl}`);

  // AutoDJ: sesión nueva si no hay cola viva; y se pide la lista COMPLETA en
  // segundo plano (1 llamada flat) para que la 🎲 salga de TODAS las canciones
  // aunque el loader todavía no las haya encolado.
  if (!queueCount(client, guildId)) AutoDjSource.reset(client, guildId);
  AutoDjSource.setKeep(client, guildId, true);
  fetchPlaylistAllURLsFlat(playlistUrl, 1000)
    .then((all) => {
      const n = AutoDjSource.register(client, guildId, all);
      if (n) log(client, guildId, `AutoDJ: lista completa conocida (${all.length} urls, +${n} nuevas).`);
    })
    .catch(() => {});

  const firstUrl = await fetchPlaylistFirstURL(playlistUrl);
  const firstFetchMs = Date.now() - t0;
  if (!firstUrl) {
    log(client, guildId, "No se pudo obtener la primera URL. Abortando.");
    return { matchedCount: 0, firstPlayed: false, urls: [], skipped: [] };
  }
  log(client, guildId, `Primera URL obtenida en ${firstFetchMs}ms. Reproduciendo al instante.`);

  const skipped = [];
  let loaded = 0;
  let allUrls = [];

  // Join and play the first track immediately.
  try {
    await client.distube.voices.join(channel);
  } catch (e) {
    log(client, guildId, `Error uniéndose al canal de voz: ${e.message}`);
  }
  AutoDjSource.register(client, guildId, [firstUrl]);
  try {
    await client.distube.play(channel, firstUrl, playOpts);
    loaded++;
    allUrls.push(firstUrl);
    log(client, guildId, `Primera canción arrancando tras ${Date.now() - t0}ms. Cola: ${queueCount(client, guildId)}`);
    if (onStatus) {
      try { await onStatus("🔊 Primer canción en reproducción, cargando lista..."); } catch {}
    }
  } catch (e) {
    // Un video caído (canal terminado / borrado / privado) NO debe tumbar la
    // carga: se marca como omitido y el resto de la lista sigue encolándose.
    skipped.push(firstUrl);
    log(
      client,
      guildId,
      isUnavailableVideoError(e)
        ? `Primer video no disponible (${friendlyUnavailableError(e)}). Se omite y se sigue con el resto de la lista.`
        : `Error al reproducir primera canción: ${e.message}. Se omite y se sigue con el resto de la lista.`
    );
    if (onStatus) {
      try { await onStatus("⚠️ Primer video no disponible, saltando al siguiente..."); } catch {}
    }
  }

  // Stream the rest (from item 2) in the background.
  client.playlistLoading.set(guildId, true);
  const batchesMs = Date.now();

  try {
    await new Promise((resolve, reject) => {
      fetchPlaylistURLsIncrementally(
        playlistUrl,
        async (urls, isLastChunk) => {
          const qBefore = queueCount(client, guildId);
          // Respaldo por si la llamada flat falló: la fuente crece con cada lote.
          AutoDjSource.register(client, guildId, urls);
          for (const url of urls) {
            if (!client.playlistLoading.get(guildId) || client.playlistStopped?.get?.(guildId)) {
              log(client, guildId, "Carga cancelada por solicitud del usuario.");
              return false; // aborta el streaming
            }
            // El AutoDJ ya eligió (o ya sonó) este tema: no se encola de nuevo.
            if (AutoDjSource.isUsed(client, guildId, url)) {
              loaded++;
              allUrls.push(url);
              continue;
            }
            // Adaptive pacing: hurry when the queue is about to run dry.
            const q = queueCount(client, guildId);
            try {
              await client.distube.play(channel, url, { ...playOpts, skip: false });
              loaded++;
              allUrls.push(url);
            } catch (e) {
              // Video caído dentro del lote: se omite, la lista sigue.
              skipped.push(url);
              log(
                client,
                guildId,
                `Video omitido (${isUnavailableVideoError(e) ? friendlyUnavailableError(e) : e.message}): ${url}`
              );
            }
            if (q > LOW_QUEUE_SAFETY) {
              await new Promise((r) => setTimeout(r, 120));
            }
          }
          const qAfter = queueCount(client, guildId);
          log(client, guildId, `Lote procesado: +${urls.length} (total ${loaded}). Cola: ${qBefore} -> ${qAfter} (${Math.round((Date.now() - batchesMs) / 1000)}s)`);
          if (onStatus && (isLastChunk || loaded % 50 === 0)) {
            try { await onStatus(`⏳ Cargando lista: \`${loaded}\` canciones... (cola ${qAfter})`); } catch {}
          }
        },
        { startItem: 2, maxItems: 1000 }
      )
        .then(resolve)
        .catch(reject);
    });
  } catch (e) {
    log(client, guildId, `Error cargando el resto de la lista: ${e.message}`);
  } finally {
    client.playlistLoading.delete(guildId);
    AutoDjSource.setKeep(client, guildId, false);
  }

  const totalMs = Date.now() - t0;
  log(
    client,
    guildId,
    `Carga completa: ${loaded} canciones en ${Math.round(totalMs / 1000)}s` +
      (skipped.length ? ` (${skipped.length} omitidas por no estar disponibles)` : "") +
      `. Cola final: ${queueCount(client, guildId)}`
  );
  // firstPlayed = quedó ALGO sonando/encolado (da igual si el video #1 estaba caído).
  return { matchedCount: loaded, firstPlayed: loaded > 0, urls: allUrls, skipped };
}

/**
 * Reproduce una lista ya conocida (p.ej. una guardada) en modo ALEATORIO:
 * baraja las urls y las va encolando de a una en el fondo, igual que el loader.
 * Lo usa el botón "🔀 Reproducir aleatorio" de Tus listas guardadas: la lista
 * ya viene mezclada y el AutoDJ solo mete 🛸 recomendaciones en medio.
 *
 * @param {object} params
 * @param {import("./Client")} params.client
 * @param {any} params.channel
 * @param {string[]} params.urls urls de la lista a mezclar
 * @param {object} params.playOpts
 * @param {(msg: string) => Promise<void>|void} [params.onStatus]
 * @returns {Promise<{ matchedCount: number, firstPlayed: boolean }>}
 */
async function shufflePlay({ client, channel, urls, playOpts, onStatus }) {
  const guildId = channel.guild.id;
  const unique = [...new Set((urls || []).filter(Boolean))];
  if (!unique.length) return { matchedCount: 0, firstPlayed: false };

  // Baraja real (Fisher-Yates) para que la lista venga mezclada.
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }

  // Clear any stale stop flag so this new load is never cancelled mid-stream.
  client.playlistStopped?.delete?.(guildId);
  // El AutoDJ puede conocer TODAS las urls (por si se quiere una 🎲 de la lista).
  AutoDjSource.register(client, guildId, unique);

  try { await client.distube.voices.join(channel); } catch (e) {}

  client.playlistLoading.set(guildId, true);
  let loaded = 0;
  try {
    for (let i = 0; i < unique.length; i++) {
      if (!client.playlistLoading.get(guildId) || client.playlistStopped?.get?.(guildId)) {
        log(client, guildId, "Carga aleatoria cancelada por solicitud del usuario.");
        break;
      }
      // El AutoDJ ya eligió / ya sonó esta url: no se encola de nuevo.
      if (AutoDjSource.isUsed(client, guildId, unique[i])) { loaded++; continue; }
      try {
        await client.distube.play(channel, unique[i], {
          ...playOpts,
          skip: i === 0 ? undefined : false,
        });
        loaded++;
      } catch (e) {
        log(client, guildId, `Video omitido en lista aleatoria (${e?.message || e}): ${unique[i]}`);
      }
      if (onStatus && loaded % 25 === 0) {
        try { await onStatus(`⏳ Lista aleatoria: \`${loaded}\` canciones encoladas...`); } catch {}
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  } finally {
    client.playlistLoading.delete(guildId);
  }
  log(client, guildId, `Lista aleatoria terminada: ${loaded} canciones encoladas.`);
  return { matchedCount: loaded, firstPlayed: loaded > 0 };
}

module.exports = { streamPlaylist, shufflePlay, LOW_QUEUE_SAFETY };