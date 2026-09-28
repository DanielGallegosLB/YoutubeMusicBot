const { fetchPlaylistFirstURL, fetchPlaylistURLsIncrementally } = require("./PlaylistFetcher");

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
 * @returns {Promise<{ matchedCount: number, firstPlayed: boolean, urls: string[] }>}
 */
async function streamPlaylist({ client, channel, playlistUrl, playOpts, onStatus }) {
  const guildId = channel.guild.id;
  const t0 = Date.now();

  // Clear any stale stop flag (e.g. set by a previous /stop or the Stop button)
  // so this new load is never cancelled the moment streaming starts.
  client.playlistStopped?.delete?.(guildId);

  log(client, guildId, `Iniciando carga de playlist: ${playlistUrl}`);

  const firstUrl = await fetchPlaylistFirstURL(playlistUrl);
  const firstFetchMs = Date.now() - t0;
  if (!firstUrl) {
    log(client, guildId, "No se pudo obtener la primera URL. Abortando.");
    return { matchedCount: 0, firstPlayed: false, urls: [] };
  }
  log(client, guildId, `Primera URL obtenida en ${firstFetchMs}ms. Reproduciendo al instante.`);

  // Join and play the first track immediately.
  try {
    await client.distube.voices.join(channel);
  } catch (e) {
    log(client, guildId, `Error uniéndose al canal de voz: ${e.message}`);
  }
  try {
    await client.distube.play(channel, firstUrl, playOpts);
  } catch (e) {
    log(client, guildId, `Error al reproducir primera canción: ${e.message}. Abortando carga.`);
    return { matchedCount: 0, firstPlayed: false, urls: [firstUrl] };
  }
  log(client, guildId, `Primera canción arrancando tras ${Date.now() - t0}ms. Cola: ${queueCount(client, guildId)}`);

  if (onStatus) {
    try { await onStatus("🔊 Primer canción en reproducción, cargando lista..."); } catch {}
  }

  // Stream the rest (from item 2) in the background.
  client.playlistLoading.set(guildId, true);
  let loaded = 1;
  const batchesMs = Date.now();
  let allUrls = [firstUrl];

  try {
    const restUrls = await new Promise((resolve, reject) => {
      fetchPlaylistURLsIncrementally(
        playlistUrl,
        async (urls, isLastChunk) => {
          const qBefore = queueCount(client, guildId);
          for (const url of urls) {
            if (!client.playlistLoading.get(guildId) || client.playlistStopped?.get?.(guildId)) {
              log(client, guildId, "Carga cancelada por solicitud del usuario.");
              return false; // aborta el streaming
            }
            // Adaptive pacing: hurry when the queue is about to run dry.
            const q = queueCount(client, guildId);
            try {
              await client.distube.play(channel, url, { ...playOpts, skip: false });
              loaded++;
              allUrls.push(url);
            } catch (e) {}
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
    allUrls = allUrls.concat(restUrls.filter((u) => !allUrls.includes(u)));
  } catch (e) {
    log(client, guildId, `Error cargando el resto de la lista: ${e.message}`);
  } finally {
    client.playlistLoading.delete(guildId);
  }

  const totalMs = Date.now() - t0;
  log(client, guildId, `Carga completa: ${loaded} canciones en ${Math.round(totalMs / 1000)}s. Cola final: ${queueCount(client, guildId)}`);
  return { matchedCount: loaded, firstPlayed: true, urls: allUrls };
}

module.exports = { streamPlaylist, LOW_QUEUE_SAFETY };