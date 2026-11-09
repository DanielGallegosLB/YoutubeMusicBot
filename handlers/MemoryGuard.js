/**
 * Vigía de memoria.
 *  - Cada 5 min (cada 1 min si el heap pasa de 1.5 GB) deja en el log: heap, rss,
 *    external/arrayBuffers y el tamaño de las estructuras que más crecen
 *    (colas, previousSongs, historial, cachés). Así, si vuelve a crecer, el log
 *    dice QUÉ crece.
 *  - Recorta previousSongs (DisTube lo deja crecer sin límite mientras la cola vive).
 *  - Si el heap pasa de MEM_RESTART_MB (3200 por defecto) guarda el historial y sale
 *    con código 75; start.bat lo vuelve a levantar y el autoresume restaura la cola.
 *    Mejor un reinicio ordenado que el crash "heap out of memory" a los 4 GB.
 */
const SongIdentity = require("./SongIdentity");

const mb = (n) => Math.round((Number(n) || 0) / 1048576);
const RESTART_MB = Number(process.env.MEM_RESTART_MB) || 3200;
const PREV_KEEP = Number(process.env.MEM_PREV_KEEP) || 25;

function mapSize(v) {
  try { return v instanceof Map || v instanceof Set ? v.size : Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0; }
  catch (_) { return 0; }
}

module.exports = function startMemoryGuard(client) {
  let restarting = false;
  let last = 0;

  const tick = async () => {
    try {
      const m = process.memoryUsage();
      const heap = mb(m.heapUsed);
      const hot = heap > 1500;
      const now = Date.now();

      // 1) previousSongs sin límite
      let songs = 0, prev = 0, queues = 0;
      try {
        const col = client.distube?.queues?.collection;
        if (col) for (const q of col.values()) {
          queues++;
          songs += q.songs?.length || 0;
          if (Array.isArray(q.previousSongs) && q.previousSongs.length > PREV_KEEP) {
            q.previousSongs.splice(0, q.previousSongs.length - PREV_KEEP);
          }
          prev += q.previousSongs?.length || 0;
        }
      } catch (_) {}

      // 2) cachés con vencimiento propio que nadie barría
      try {
        for (const name of ["_streamDead", "_ffmpegLogAt", "_streamFails"]) {
          const mp = client[name];
          if (!(mp instanceof Map)) continue;
          for (const [k, v] of mp) {
            const t = typeof v === "number" ? v : Number(v?.until || v?.at || 0);
            if (typeof v === "number" ? v < now : t && now - t > 3600e3) mp.delete(k);
          }
        }
      } catch (_) {}

      if (hot || now - last >= 300e3) {
        last = now;
        const sizes = {};
        for (const k of Object.keys(client)) {
          if (!/^(_|autoDj|actualPlaying|favPages|queuePages|likeClaims|ffmpegRetry)/.test(k)) continue;
          const n = mapSize(client[k]);
          if (n > 200) sizes[k] = n;
        }
        client.logger.warn?.(
          `[Mem] heap=${heap}MB rss=${mb(m.rss)}MB ext=${mb(m.external)}MB ab=${mb(m.arrayBuffers)}MB` +
          ` | colas=${queues} songs=${songs} prev=${prev} guilds=${client.guilds?.cache?.size || 0}` +
          ` | uptime=${Math.round(process.uptime() / 3600)}h` +
          (Object.keys(sizes).length ? ` | grandes=${JSON.stringify(sizes)}` : "")
        );
      }

      // 3) reinicio ordenado antes del crash
      if (heap >= RESTART_MB && !restarting) {
        restarting = true;
        client.logger.error?.(`[Mem] heap=${heap}MB ≥ ${RESTART_MB}MB → guardando y reiniciando (exit 75).`);
        try {
          for (const g of client.guilds.cache.keys()) await SongIdentity.history.flush(client, g);
        } catch (_) {}
        setTimeout(() => process.exit(75), 3000);
      }
    } catch (_) {}
  };

  const t = setInterval(tick, 60e3);
  if (t.unref) t.unref();
};
