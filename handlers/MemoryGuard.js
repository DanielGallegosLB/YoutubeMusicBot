/**
 * Vigía de memoria + cazador de fugas.
 *
 *  1) LOG [Mem] (cada 5 min; cada 1 min si el heap pasa de 1.5 GB): heap, rss, colas,
 *     canciones, previousSongs y estructuras grandes.
 *  2) CAZADOR: perfilador de muestreo de V8 (HeapProfiler.startSampling) encendido desde
 *     el arranque (costo ~1-2 %). Cuando el heap VIVO (tras forzar un GC) pasa de
 *     MEM_PROFILE_MB (400) —y luego cada +400 MB— escribe `memleak-report.txt` y las 12
 *     primeras líneas en el log: las funciones/archivos/líneas que reservaron la memoria
 *     que SIGUE viva. Eso señala la fuga con nombre y apellido.
 *  3) SIN reinicios rutinarios. Solo una red de seguridad (MEM_RESTART_MB=5600) para no
 *     morir por "out of memory" bruscamente, y un reinicio opcional cuando no hay
 *     oyentes (MEM_SOFT_MB, apagado por defecto). Sale con código 75; start.bat lo
 *     levanta y el autoresume restaura la cola.
 *  4) Recorta previousSongs y barre cachés con vencimiento.
 */
const fs = require("fs");
const path = require("path");
const SongIdentity = require("./SongIdentity");

const mb = (n) => Math.round((Number(n) || 0) / 1048576);
// Por defecto el bot NO se reinicia por memoria: solo hay una red de seguridad a
// 5600 MB (el límite del heap está en 6144 MB, ver start.bat). MEM_SOFT_MB>0 activa
// un reinicio "cuando no hay oyentes" para quien lo quiera.
const SOFT_MB = Number(process.env.MEM_SOFT_MB) || 0;
const HARD_MB = Number(process.env.MEM_RESTART_MB) || 5600;
const PROFILE_MB = Number(process.env.MEM_PROFILE_MB) || 400;
const PROFILE_STEP_MB = Number(process.env.MEM_PROFILE_STEP_MB) || 300;
const PREV_KEEP = Number(process.env.MEM_PREV_KEEP) || 25;
const REPORT = path.join(process.cwd(), "memleak-report.txt");

// GC manual (solo se usa para medir el heap VIVO y para el informe).
let forceGc = null;
try {
  require("v8").setFlagsFromString("--expose-gc");
  forceGc = require("vm").runInNewContext("gc");
} catch (_) {}

// Perfilador de muestreo (muestras de lo que SIGUE vivo).
let session = null;
try {
  const inspector = require("inspector");
  session = new inspector.Session();
  session.connect();
  session.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: false,
    includeObjectsCollectedByMinorGC: false,
  });
} catch (_) { session = null; }

function mapSize(v) {
  try { return v instanceof Map || v instanceof Set ? v.size : Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0; }
  catch (_) { return 0; }
}

function getProfile() {
  return new Promise((resolve) => {
    if (!session) return resolve(null);
    try { session.post("HeapProfiler.getSamplingProfile", (err, res) => resolve(err ? null : res?.profile || null)); }
    catch (_) { resolve(null); }
  });
}

// Aplana el árbol: bytes vivos por (función, archivo:línea) y por archivo.
function summarize(profile) {
  const byFn = new Map(), byFile = new Map();
  let total = 0;
  const walk = (n) => {
    const cf = n.callFrame || {};
    const file = String(cf.url || "(nativo)").replace(/^file:\/\/\/?/, "").split(/[\\/]/).slice(-2).join("/");
    const key = `${cf.functionName || "(anónima)"}  ${file}:${(cf.lineNumber || 0) + 1}`;
    const sz = n.selfSize || 0;
    if (sz) {
      byFn.set(key, (byFn.get(key) || 0) + sz);
      byFile.set(file, (byFile.get(file) || 0) + sz);
      total += sz;
    }
    for (const c of n.children || []) walk(c);
  };
  walk(profile.head);
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  return { total, fns: top(byFn, 40), files: top(byFile, 15) };
}

module.exports = function startMemoryGuard(client) {
  let restarting = false;
  let last = 0;
  let nextProfileAt = PROFILE_MB;
  let lastGcAt = 0;

  const humansWithBot = () => {
    let n = 0;
    try {
      for (const g of client.guilds.cache.values()) {
        const vc = g.members?.me?.voice?.channel;
        if (vc) n += vc.members.filter((m) => !m.user.bot).size;
      }
    } catch (_) {}
    return n;
  };

  const report = async (reason, heapNow) => {
    try {
      const profile = await getProfile();
      if (!profile) return;
      const s = summarize(profile);
      const lines = [
        `=== ${new Date().toISOString()} · ${reason} · heap=${heapNow}MB · muestreado vivo=${mb(s.total)}MB · uptime=${Math.round(process.uptime() / 3600)}h ===`,
        `-- Por archivo --`,
        ...s.files.map(([k, v]) => `${String(mb(v)).padStart(6)} MB  ${k}`),
        `-- Por función (archivo:línea donde se reservó) --`,
        ...s.fns.map(([k, v]) => `${String(mb(v)).padStart(6)} MB  ${k}`),
        "",
      ];
      try { fs.appendFileSync(REPORT, lines.join("\n") + "\n"); } catch (_) {}
      client.logger.warn?.(`[MemLeak] ${reason}: top vivo → ` + s.fns.slice(0, 12).map(([k, v]) => `${mb(v)}MB ${k}`).join(" | "));
    } catch (_) {}
  };

  const restart = async (why) => {
    if (restarting) return;
    restarting = true;
    client.logger.error?.(`[Mem] ${why} → guardando y reiniciando (exit 75).`);
    await report("antes de reiniciar", mb(process.memoryUsage().heapUsed));
    try {
      for (const g of client.guilds.cache.keys()) await SongIdentity.history.flush(client, g);
    } catch (_) {}
    // Almacén en memoria: guardar lo pendiente ANTES de salir (también lo hace el hook 'exit').
    try { await Promise.all([client.music?.flush?.(), client.autoresume?.flush?.()]); } catch (_) {}
    setTimeout(() => process.exit(75), 3000);
  };

  // Estado de la cola de escrituras de Josh (ver Database.js): pendientes, combinadas,
  // máximo alcanzado y cuánto lleva atascada la escritura en curso.
  const dbInfo = () => {
    try {
      const parts = [];
      for (const n of ["music", "autoresume"]) {
        const w = client[n]?.writeStats?.();
        if (!w) continue;
        parts.push(`${n}:pend=${w.pending},max=${w.maxPending},merged=${w.coalesced},ok=${w.writes},fail=${w.failed}` + (w.stuckMs > 5000 ? `,STUCK=${Math.round(w.stuckMs / 1000)}s` : ""));
      }
      return parts.length ? ` | dbQ{${parts.join(" ")}}` : "";
    } catch (_) { return ""; }
  };

  const tick = async () => {
    try {
      const m = process.memoryUsage();
      let heap = mb(m.heapUsed);
      const now = Date.now();

      // previousSongs sin límite
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

      // cachés con vencimiento propio que nadie barría
      try {
        for (const name of ["_streamDead", "_ffmpegLogAt", "_streamFails", "_streamURLCache"]) {
          const mp = client[name];
          if (!(mp instanceof Map)) continue;
          for (const [k, v] of mp) {
            const t = typeof v === "number" ? v : Number(v?.until || v?.at || 0);
            if (typeof v === "number" ? v < now : t && now - t > 3600e3) mp.delete(k);
          }
        }
      } catch (_) {}

      // Con heap alto, se mide el heap VIVO (GC forzado, máx. 1 vez cada 10 min).
      let live = null;
      if (forceGc && heap >= PROFILE_MB && now - lastGcAt > 600e3) {
        lastGcAt = now;
        try { forceGc(); live = mb(process.memoryUsage().heapUsed); heap = live; } catch (_) {}
      }

      const hot = heap > 1500;
      if (hot || now - last >= 300e3) {
        last = now;
        const sizes = {};
        for (const k of Object.keys(client)) {
          if (!/^(_|autoDj|actualPlaying|favPages|queuePages|likeClaims|ffmpegRetry)/.test(k)) continue;
          const n = mapSize(client[k]);
          if (n > 200) sizes[k] = n;
        }
        client.logger.warn?.(
          `[Mem] heap=${heap}MB${live != null ? "(vivo)" : ""} rss=${mb(m.rss)}MB ext=${mb(m.external)}MB ab=${mb(m.arrayBuffers)}MB` +
          ` | colas=${queues} songs=${songs} prev=${prev} guilds=${client.guilds?.cache?.size || 0}` +
          ` | uptime=${Math.round(process.uptime() / 3600)}h` +
          dbInfo() +
          (Object.keys(sizes).length ? ` | grandes=${JSON.stringify(sizes)}` : "")
        );
      }

      // Informe de la fuga (con el heap vivo ya medido)
      if (live != null && live >= nextProfileAt) {
        nextProfileAt = live + PROFILE_STEP_MB;
        await report(`heap vivo ${live}MB`, live);
      }

      // Reinicio ordenado
      if (!restarting) {
        if (heap >= HARD_MB) await restart(`heap=${heap}MB ≥ ${HARD_MB}MB (límite duro)`);
        else if (SOFT_MB > 0 && heap >= SOFT_MB && humansWithBot() === 0) await restart(`heap=${heap}MB ≥ ${SOFT_MB}MB y no hay oyentes (reinicio suave)`);
      }
    } catch (_) {}
  };

  const t = setInterval(tick, 60e3);
  if (t.unref) t.unref();
};
