/**
 * Fuente de la canción "🎲 aleatoria" del AutoDJ: TODA la lista que el usuario
 * ingresó (p.ej. las 316), aunque el loader todavía no la haya encolado entera.
 *
 * Estado por guild y por sesión de reproducción:
 *   urls  → orden original de la lista (sin duplicados)
 *   used  → urls que ya sonaron o que el AutoDJ ya eligió (no se repiten y el
 *           loader NO las vuelve a encolar)
 *   keep  → true mientras streamPlaylist está corriendo (evita que initQueue
 *           borre la fuente recién registrada)
 */
function stateOf(client, guildId) {
  if (!(client.autoDjSource instanceof Map)) client.autoDjSource = new Map();
  let st = client.autoDjSource.get(guildId);
  if (!st) {
    st = { urls: [], set: new Set(), used: new Set(), keep: false };
    client.autoDjSource.set(guildId, st);
  }
  return st;
}

/** Suma urls a la fuente (dedup, conserva el orden de llegada). */
function register(client, guildId, urls) {
  const st = stateOf(client, guildId);
  let added = 0;
  for (const u of urls || []) {
    if (!u || st.set.has(u)) continue;
    st.set.add(u);
    st.urls.push(u);
    added++;
  }
  return added;
}

/** Suma a la fuente las canciones que ya están en la cola (sin la que suena). */
function syncFromQueue(client, guildId, queue) {
  // Las canciones que puso el AutoDJ NO son "de la lista": no se registran.
  const urls = (queue?.songs || [])
    .slice(1)
    .filter((s) => s && !s.autoDj && !s._autoDj)
    .map((s) => s.url)
    .filter(Boolean);
  return register(client, guildId, urls);
}

function markUsed(client, guildId, url) {
  if (url) stateOf(client, guildId).used.add(url);
}

function isUsed(client, guildId, url) {
  return !!url && stateOf(client, guildId).used.has(url);
}

/** Nueva sesión: olvida fuente y usadas. */
function reset(client, guildId) {
  client.autoDjSource?.delete?.(guildId);
}

function setKeep(client, guildId, keep) {
  stateOf(client, guildId).keep = !!keep;
}

/** initQueue: si no hay una carga de lista en curso, la sesión es nueva. */
function resetUnlessLoading(client, guildId) {
  const st = client.autoDjSource?.get?.(guildId);
  if (st && !st.keep) reset(client, guildId);
}

/**
 * Candidatas para una 🎲: de toda la lista, sin usar ni excluidas ni ya
 * elegidas en este refill ni la que está sonando.
 */
function candidates(client, guildId, { excluded, taken, currentUrl } = {}) {
  const st = stateOf(client, guildId);
  return st.urls.filter(
    (u) => !st.used.has(u) && u !== currentUrl && !excluded?.has(u) && !taken?.has(u)
  );
}

/**
 * Marca de "esta canción la encoló el loader de una LISTA" (📋) para distinguirla
 * de un pedido manual por comando/botón (🙋). El loader avisa antes de cada play()
 * y el evento addSong lo consume.
 */
const listKey = (u) => {
  const m = String(u || "").match(/(?:[?&]v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/);
  return m ? `yt:${m[1]}` : String(u || "").trim();
};
function expectListSong(client, guildId, url) {
  if (!guildId || !url) return;
  const st = stateOf(client, guildId);
  if (!(st.listExpect instanceof Map)) st.listExpect = new Map();
  st.listExpect.set(listKey(url), Date.now());
}
function takeListExpect(client, guildId, url) {
  const st = client?.autoDjSource?.get?.(guildId);
  if (!st || !(st.listExpect instanceof Map)) return false;
  const k = listKey(url);
  const at = st.listExpect.get(k);
  if (at == null) return false;
  st.listExpect.delete(k);
  return Date.now() - at < 180000;
}

/**
 * Canciones de la lista ya usadas, de la que MÁS tiempo hace que se usó a la más
 * reciente (el Set conserva el orden de inserción). Para reciclar sin repetir
 * siempre las mismas cuando la lista se agota.
 */
function recyclable(client, guildId, { excluded, taken, currentUrl, inQueue } = {}) {
  const st = stateOf(client, guildId);
  const out = [];
  for (const u of st.used) {
    if (!st.set.has(u) || u === currentUrl) continue;
    if (excluded?.has(u) || taken?.has(u) || inQueue?.has(u)) continue;
    out.push(u);
  }
  return out;
}

/** Saca una url de "usadas" (se vuelve a marcar al elegirla y pasa al final). */
function unuse(client, guildId, url) {
  if (url) stateOf(client, guildId).used.delete(url);
}

module.exports = { recyclable, unuse, register, syncFromQueue, markUsed, isUsed, reset, setKeep, resetUnlessLoading, candidates, stateOf, expectListSong, takeListExpect };