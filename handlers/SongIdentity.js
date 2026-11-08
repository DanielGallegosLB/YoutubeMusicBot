/**
 * Identidad de canciones: "¿es la misma canción?" por PARECIDO de nombre, y
 * registro de la ÚLTIMA VEZ que sonó cada una.
 *
 * Problema que resuelve: la misma canción llega con URLs distintas ("Fly Away",
 * "Lenny Kravitz - Fly Away (Official Video)", "Fly Away [Remastered]") y el
 * AutoDJ las trataba como distintas → repetía temas y los traía como "novedad"
 * aunque el bot ya los conocía.
 *
 * Todo es puro y sin dependencias de Discord, salvo `history` que guarda en
 * `client.music` bajo `${guildId}.lastPlayed`.
 */

const SIM_THRESHOLD = Math.min(0.99, Math.max(0.6, Number(process.env.AUTODJ_TITLE_SIM) || 0.85));
const HISTORY_MAX = Math.max(500, Number(process.env.AUTODJ_HISTORY_MAX) || 4000);
const FLUSH_MS = 5000;

// Ruido que NO distingue una canción de otra. "live", "remix", "slowed", "sped up",
// "cover", "acoustic"... NO están aquí a propósito: son versiones distintas.
const NOISE = new Set((
  "official oficial video videoclip clip music audio lyrics lyric letra hd hq 4k 8k remaster remastered " +
  "remasterizado visualizer visualiser explicit clean version ver edit radio single stone mono stereo " +
  "topic vevo sub subtitulado subtitulada espanol en with the a"
).split(" "));

const stripAccents = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Clave canónica de URL (mismo video aunque cambie &list=, &t=, youtu.be…). */
function ytKey(url) {
  const u = String(url || "").trim();
  const m = u.match(/(?:[?&]v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/);
  return m ? `yt:${m[1]}` : u;
}

function tokensOf(text) {
  return stripAccents(String(text).toLowerCase())
    .replace(/['’`´]/g, "")                 // don't → dont
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !NOISE.has(t) && !/^(19|20)\d{2}$/.test(t));
}

/**
 * Formas comparables de un nombre: el nombre completo y cada parte separada por
 * " - " / " | " / ":" ("Artista - Título"). Se quita lo que va entre ()[]{} y
 * lo que viene después de feat./ft.
 */
const _formsCache = new Map();
function formsOf(name) {
  const raw = String(name || "");
  const hit = _formsCache.get(raw);
  if (hit) return hit;
  // Lo que va entre ()[]{} se descarta SOLO si es ruido (official, lyric video, 2011
  // remaster…). Si trae algo que distingue la versión ("Slowed + Reverb", "Live",
  // "Remix") se conserva.
  let s = raw.replace(/[\(\[\{]([^\)\]\}]*)[\)\]\}]/g, (_, inner) => (tokensOf(inner).length ? ` ${inner} ` : " "));
  s = s.replace(/\b(feat|ft|featuring)\b\.?.*$/i, " ");
  const whole = tokensOf(s);
  const parts = s.split(/\s[-–—|:]\s|\s[-–—]|[-–—]\s/).map(tokensOf).filter((p) => p.length);
  const out = { whole, parts: parts.length > 1 ? parts : [] };
  if (_formsCache.size > 6000) _formsCache.clear();
  _formsCache.set(raw, out);
  return out;
}

function lev1(a, b) { // ¿distancia de edición ≤ 1?
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/** Dice sobre tokens, tolerando 1 letra de diferencia en palabras ≥5 (favourite/favorite). */
function tokenDice(A, B) {
  if (!A.length || !B.length) return 0;
  const free = B.slice();
  let hit = 0;
  for (const t of A) {
    let k = free.indexOf(t);
    if (k < 0 && t.length >= 5) k = free.findIndex((u) => u.length >= 5 && lev1(t, u));
    if (k >= 0) { hit++; free.splice(k, 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

/**
 * Parecido 0..1 entre dos nombres de canción.
 * Se compara completo↔completo y parte↔completo (así "Fly Away" ≈
 * "Lenny Kravitz - Fly Away"), pero NUNCA parte↔parte: si no, dos temas del
 * mismo artista coincidirían por el "Artista" del título.
 */
function similarity(a, b) {
  const fa = formsOf(a), fb = formsOf(b);
  const A = [fa.whole, ...fa.parts], B = [fb.whole, ...fb.parts];
  let best = 0;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (i > 0 && j > 0) continue; // parte↔parte: no
      const x = A[i], y = B[j];
      if (x.join("").length < 3 || y.join("").length < 3) continue;
      const d = tokenDice(x, y);
      if (d > best) best = d;
    }
  }
  return best;
}

const isSameSong = (a, b, thr = SIM_THRESHOLD) => similarity(a, b) >= thr;

/** Índice de nombres para buscar "el más parecido" sin comparar contra todo. */
function createIndex() {
  const items = [];
  const buckets = new Map(); // prefijo de 4 letras → [ids]
  const prefixes = (name) => {
    const f = formsOf(name);
    const set = new Set();
    for (const t of [...f.whole, ...f.parts.flat()]) set.add(t.slice(0, 4));
    return set;
  };
  return {
    get size() { return items.length; },
    add(name, meta) {
      if (!name) return;
      const id = items.push({ name, meta }) - 1;
      for (const p of prefixes(name)) {
        let b = buckets.get(p);
        if (!b) buckets.set(p, (b = []));
        b.push(id);
      }
    },
    /** Mejor coincidencia ≥ thr → { name, meta, sim } o null. */
    find(name, thr = SIM_THRESHOLD) {
      if (!name) return null;
      const seen = new Set();
      let best = null;
      for (const p of prefixes(name)) {
        for (const id of buckets.get(p) || []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const sim = similarity(name, items[id].name);
          if (sim >= thr && (!best || sim > best.sim)) best = { name: items[id].name, meta: items[id].meta, sim };
        }
      }
      return best;
    },
  };
}

/** De varias versiones de la misma canción deja la de MENOR duración (sin intro/relleno). */
function dedupeShortest(list, getName, getDur, thr = SIM_THRESHOLD) {
  const groups = [];
  for (const it of list) {
    const nm = getName(it);
    const g = groups.find((x) => similarity(nm, getName(x[0])) >= thr);
    if (g) g.push(it); else groups.push([it]);
  }
  return groups.map((g) => g.reduce((m, x) => ((Number(getDur(x)) || 1e9) < (Number(getDur(m)) || 1e9) ? x : m)));
}

function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "hace instantes";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (s < 60) return "hace instantes";
  if (m < 60) return `hace ${m} min`;
  if (h < 24) return `hace ${h} h ${m % 60} min`;
  if (d < 60) return `hace ${d} d ${h % 24} h`;
  return `hace ${Math.floor(d / 30)} meses`;
}

/** Versión corta para listas: 12m / 5h / 3d / 2mes. */
function formatAgoShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "ahora";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (m < 1) return "ahora";
  if (m < 60) return `${m}m`;
  if (h < 24) return `${h}h`;
  if (d < 60) return `${d}d`;
  return `${Math.floor(d / 30)}mes`;
}

/** Clave de artista/canal comparable: sin acentos, solo letras y números. */
const artistKey = (x) => stripAccents(String(x || "").toLowerCase()).replace(/\s*-\s*topic$/i, "").replace(/[^a-z0-9]+/g, " ").trim();

// ── Historial persistente: cuándo sonó cada canción por última vez ───────────
//   entrada: { n: nombre, t: última vez, p: vez anterior (o null), c: veces,
//              pn: nombre de la "parecida" si la anterior fue otra URL }
const _state = new Map(); // guildId → { map, index, dirty, timer, loading }

async function load(client, guildId) {
  let st = _state.get(guildId);
  if (st?.ready) return st;
  if (st?.loading) return st.loading;
  st = st || { map: new Map(), index: createIndex(), dirty: false, timer: null, ready: false, client };
  _state.set(guildId, st);
  st.loading = (async () => {
    try {
      const raw = await client.music.get(`${guildId}.lastPlayed`);
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          if (!v || !v.t) continue;
          st.map.set(k, v);
          st.index.add(v.n, { key: k });
        }
      }
    } catch (_) {}
    st.ready = true;
    st.loading = null;
    return st;
  })();
  return st.loading;
}

function scheduleFlush(client, guildId, st) {
  st.dirty = true;
  if (st.timer) return;
  st.timer = setTimeout(() => flush(client, guildId), FLUSH_MS);
  if (st.timer.unref) st.timer.unref();
}

async function flush(client, guildId) {
  const st = _state.get(guildId);
  if (!st) return;
  st.timer = null;
  if (!st.dirty) return;
  st.dirty = false;
  try {
    if (st.map.size > HISTORY_MAX) {
      const old = [...st.map.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, st.map.size - HISTORY_MAX);
      for (const [k] of old) st.map.delete(k);
    }
    await client.music.set(`${guildId}.lastPlayed`, Object.fromEntries(st.map));
  } catch (e) {
    st.dirty = true;
    try { client.logger?.warn?.(`[Historial] no se pudo guardar lastPlayed: ${e?.message || e}`); } catch (_) {}
  }
}

/**
 * Registra una reproducción. Devuelve el estado ANTERIOR para loguear:
 * { first, prevT, prevName, via: "url"|"parecida"|null, sim, count }.
 */
async function record(client, guildId, { url, name }) {
  const st = await load(client, guildId);
  const key = ytKey(url);
  const now = Date.now();
  let e = st.map.get(key);
  let info;
  if (e) {
    info = { first: false, prevT: e.t, prevName: e.n, via: "url", sim: 1, count: (e.c || 1) + 1 };
    e.p = e.t; e.pn = null; e.t = now; e.c = info.count; if (name) e.n = name;
  } else {
    const m = st.index.find(name);
    const sib = m ? st.map.get(m.meta.key) : null;
    info = sib
      ? { first: false, prevT: sib.t, prevName: sib.n, via: "parecida", sim: m.sim, count: (sib.c || 1) + 1 }
      : { first: true, prevT: null, prevName: null, via: null, sim: 0, count: 1 };
    e = { n: name || key, t: now, p: info.prevT, pn: sib ? sib.n : null, c: info.count };
    st.map.set(key, e);
    st.index.add(e.n, { key });
  }
  scheduleFlush(client, guildId, st);
  return info;
}

/**
 * Última vez (sin esperar I/O: usa lo ya cargado). Devuelve la entrada más
 * reciente entre la misma URL y las de nombre parecido:
 * { t, p, n, c, exact, sim } o null.
 */
function lastFor(guildId, { url, name }) {
  const st = _state.get(guildId);
  if (!st?.ready) return null;
  const direct = st.map.get(ytKey(url));
  let best = direct ? { t: direct.t, p: direct.p || null, n: direct.n, c: direct.c || 1, exact: true, sim: 1 } : null;
  const m = name ? st.index.find(name) : null;
  if (m) {
    const e = st.map.get(m.meta.key);
    if (e && (!best || e.t > best.t)) best = { t: e.t, p: e.p || null, n: e.n, c: e.c || 1, exact: e === direct, sim: m.sim };
  }
  return best;
}

/** Índice de TODO lo que el bot ha reproducido (para rechazar "novedades" ya conocidas). */
function playedIndex(guildId) {
  return _state.get(guildId)?.index || createIndex();
}

// Guarda lo pendiente al apagar el bot (si no, se perdían hasta FLUSH_MS de historial).
if (!global.__songHistoryExit) {
  global.__songHistoryExit = true;
  const flushAll = () => { for (const [gid, st] of _state) { if (st.dirty && st.client) flush(st.client, gid).catch(() => {}); } };
  process.on("beforeExit", flushAll);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flushAll(); setTimeout(() => process.exit(0), 800); });
}

module.exports = {
  SIM_THRESHOLD,
  ytKey,
  similarity,
  isSameSong,
  createIndex,
  dedupeShortest,
  formatAgo,
  formatAgoShort,
  artistKey,
  history: { load, record, lastFor, playedIndex, flush },
};