/**
 * Orden del AutoDJ + etiquetas de origen: UNA sola fuente de verdad.
 *
 * Ciclo objetivo (infinito), con los oyentes A, B… en orden de conexión:
 *
 *   1. 🛸 recomendación        A        (liked)
 *   2. 🛸 recomendación        B
 *   3. 🎲 aleatoria de pedidas A        (aleatorias)
 *   4. 🎲 aleatoria de pedidas B
 *   5. 🎤 novedosa de perfil   A        (artistas)
 *   6. 🎤 novedosa de perfil   B
 *   (7. 🎲 aleatoria de la lista        (random) — SOLO si AUTODJ_LIST_STEP=1)
 *
 * Este módulo NO toca la cola ni Discord: son funciones puras (se pueden
 * probar con `node`).
 */

// Orden de las rondas dentro del ciclo.
const ROUND_OF = { liked: 0, rec: 0, aleatorias: 1, pedidas: 1, artistas: 2, random: 3 };

// Qué significa cada tipo, para el usuario (icono + etiqueta corta).
const TYPE_INFO = {
  liked:      { icon: "🛸", tag: "Rec",     long: "recomendación" },
  rec:        { icon: "🛸", tag: "Rec",     long: "recomendación" },
  aleatorias: { icon: "🎲", tag: "Pedidas", long: "aleatoria de pedidas" },
  pedidas:    { icon: "📝", tag: "Pedidas", long: "pedidas" },
  artistas:   { icon: "🎤", tag: "Novedad", long: "novedosa de perfil" },
  random:     { icon: "🎲", tag: "Lista",   long: "aleatoria de la lista" },
};
const MANUAL = { icon: "🎵", tag: "Manual" };      // la pidió alguien (comando/botón)
const LISTED = { icon: "📋", tag: "Lista" };       // vino de la lista que alguien cargó

const LEGEND =
  "🛸 recomendación · 🎲 aleatoria de pedidas · 🎤 novedad · 🎲 aleatoria de la lista · 🎵 manual · 📋 de la lista cargada";

// Cuando un paso no encontró lo suyo y cayó a otra fuente, se dice en el rótulo.
const FALLBACK_TAG = { "sin-novedad": "↩ sin novedad", sala: "↩ sala", reciclada: "↩ reciclada", rescate: "↩ rescate", lista: "↩ lista" };

// Nombres ÚNICOS (embed fijo, logs y dashboard usan estos mismos).
//   rec/liked → 🛸 Recomendación · pedidas/aleatorias → 🎲 Aleatoria de pedidas
//   artistas → 🎤 Novedad · random → 🎲 Aleatoria de la lista
const CANON = { rec: "liked", liked: "liked", pedidas: "aleatorias", aleatorias: "aleatorias", artistas: "artistas", random: "random" };
const NAMES = {
  liked: "🛸 Recomendación",
  aleatorias: "🎲 Aleatoria de pedidas",
  artistas: "🎤 Novedad",
  random: "🎲 Aleatoria de la lista",
};
const canonType = (t) => CANON[t] || "liked";
/** Patrón guardado (dashboard) → tipos canónicos. */
function canonPattern(pattern) {
  return (pattern || []).map((p) => {
    const type = canonType(p?.type);
    return type === "random" ? { type } : { type, userId: String(p?.userId || "*") };
  });
}

/** Ciclo completo para estos oyentes (en el orden pedido). */
function buildCycle(listeners) {
  const order = (listeners || []).filter(Boolean);
  const out = [];
  for (const uid of order) out.push({ type: "liked", userId: uid });
  for (const uid of order) out.push({ type: "aleatorias", userId: uid });
  for (const uid of order) out.push({ type: "artistas", userId: uid });
  // Por defecto el ciclo termina en las novedades; la 🎲 de la lista es opcional.
  if (/^(1|true|si|sí|on)$/i.test(String(process.env.AUTODJ_LIST_STEP || ""))) out.push({ type: "random" });
  return out;
}

/**
 * Expande un patrón PERSONALIZADO (dashboard) a pasos por persona.
 *
 * Un paso "para todos" (`userId: "*"`) se convierte en UNA RONDA COMPLETA, un
 * paso por oyente en orden de conexión, de forma consecutiva:
 *
 *   [🛸 todos, 🎤 todos, 🎲 lista]  con A, B   →   🛸A › 🛸B › 🎤A › 🎤B › 🎲 lista
 *
 * Antes cada "*" rotaba entre oyentes con un contador por tipo y SALTANDO a
 * quien no tenía contenido, así que el orden real quedaba mezclado (rec A,
 * novedad A, rec B…) y no el de "primero las recs de todos, luego las novedades
 * de todos". Cada paso expandido lleva `base` (índice del paso original).
 * Los pasos con usuario fijo y la 🎲 de la lista no se expanden.
 */
function expandPattern(pattern, listeners) {
  const order = (listeners || []).filter(Boolean);
  const out = [];
  (pattern || []).forEach((p, base) => {
    if (!p || p.type === "random") { out.push({ type: "random", base }); return; }
    const uid = p.userId && p.userId !== "*" ? p.userId : null;
    if (uid) { out.push({ type: p.type, userId: uid, base }); return; }
    if (!order.length) { out.push({ type: p.type, userId: "*", base }); return; }
    for (const u of order) out.push({ type: p.type, userId: u, base });
  });
  return out;
}

/**
 * Índice del PRÓXIMO paso de un patrón expandido, a partir del último que se
 * intentó (`{ base, userId }`). Si entra o sale alguien sigue por (paso, orden
 * del oyente) sin reiniciar la ronda ni repetir a quien ya tuvo su turno.
 */
function nextExpandedIndex(expanded, last, listeners) {
  if (!expanded?.length) return 0;
  if (!last || !Number.isInteger(last.base)) return 0;
  const ord = (u) => (u ? (listeners || []).indexOf(u) : -1);
  let lo = ord(last.userId);
  if (lo < 0 && last.userId && Array.isArray(last.order)) {
    // El último oyente atendido ya se fue: se continúa tras la posición que
    // tenía, sin repetir a los que ya tuvieron su turno en esta ronda.
    const p = last.order.indexOf(last.userId);
    if (p >= 0) lo = (listeners || []).filter((u) => { const k = last.order.indexOf(u); return k >= 0 && k <= p; }).length - 1;
  }
  for (let i = 0; i < expanded.length; i++) {
    const e = expanded[i];
    if (e.base > last.base) return i;
    if (e.base === last.base && ord(e.userId) > lo) return i;
  }
  return 0; // terminó el ciclo → empieza otro
}

/** Posición (ronda, orden del oyente) de un paso dentro del ciclo. */
function stepKey(step, listeners) {
  const round = ROUND_OF[step?.type] ?? 0;
  const ord = step?.userId ? Math.max(0, (listeners || []).indexOf(step.userId)) : 0;
  return round * 1000 + ord;
}

/**
 * Índice del PRÓXIMO paso del ciclo: el primero que viene después del último
 * que se puso. Si cambian los oyentes (entra/sale alguien) sigue por ronda y
 * por orden, sin reiniciar el ciclo ni desfasarse.
 * @param {Array} pattern  ciclo actual (buildCycle)
 * @param {{type:string,userId?:string}|null} last último paso intentado
 * @param {string[]} listeners
 */
function nextStepIndex(pattern, last, listeners) {
  if (!pattern?.length) return 0;
  if (!last) return 0;
  const lk = stepKey(last, listeners);
  for (let i = 0; i < pattern.length; i++) {
    if (stepKey(pattern[i], listeners) > lk) return i;
  }
  return 0; // terminó el ciclo → empieza otro
}

function infoOf(type) {
  return TYPE_INFO[type] || TYPE_INFO.liked;
}

/**
 * Rótulo de origen de una canción de la cola/reproductor.
 * @param {object} track  Song de DisTube (con flags del AutoDJ si aplica)
 * @param {(uid:string)=>string|null} nameOf  uid → nombre visible
 */
function originLabel(track, nameOf) {
  if (!track) return "Auto DJ";
  const nm = (uid) => (uid && nameOf ? nameOf(uid) : null);
  if (track.autoDj || track._autoDj) {
    const info = infoOf(track.autoDjType);
    if (track.autoDjType === "random") {
      if (track.autoDjFallback === "favoritas" || track.autoDjFallback === "reciclada") {
        return `🎲 Aleat. favoritos`;
      }
      if (track.fromList === false && !track._autoDjFromList) {
        return `🎲 Aleat. lista`;
      }
      return `🎲 Aleat. lista`;
    }
    if (track.autoDjType === "pedidas") {
      const who = nm(track.autoDjUserId);
      return who ? `📝 Pedidas · ${who}` : `📝 Pedidas`;
    }
    if (track.autoDjType === "aleatorias") {
      const who = nm(track.autoDjUserId);
      return who ? `🎲 Pedidas · ${who}` : `🎲 Pedidas`;
    }
    if (track.autoDjType === "artistas") {
      const who = nm(track.autoDjUserId);
      if (track.autoDjFallback === "sin-novedad") return who ? `🛸 Gusto · ${who} ↩ sin novedad` : `🛸 Gusto ↩ sin novedad`;
      return who ? `🎤 Novedad · ${who}` : `🎤 Novedad`;
    }
    const who = nm(track.autoDjUserId);
    const fb = track.autoDjFallback ? ` ${FALLBACK_TAG[track.autoDjFallback] || ""}`.trimEnd() : "";
    return `${info.icon} ${info.tag}${who ? ` · ${who}` : ""}${fb ? ` ${fb.trim()}` : ""}`;
  }
  const who =
    track.requestedBy?.tag || track.user?.tag || track.member?.user?.tag || track.user?.username || null;
  const base = track._fromList ? LISTED : MANUAL;
  return who ? `${base.icon} ${base.tag} · ${who}` : `${base.icon} ${base.tag}`;
}

/**
 * Línea del "ciclo" para el embed fijo. Marca con ▶ el paso que toca poner
 * a continuación. Ej: 🛸dani › 🛸gera › ▶🎲dani › 🎲gera › 🎤dani › 🎤gera › 🎲lista
 */
function cycleLine(pattern, nextIdx, nameOf) {
  const short = (uid) => {
    const n = (uid && nameOf ? nameOf(uid) : null) || "?";
    return n.length > 9 ? `${n.slice(0, 8)}…` : n;
  };
  return (pattern || [])
    .map((p, i) => {
      const info = infoOf(p.type);
      const label = p.type === "random" ? `${info.icon}lista` : `${info.icon}${p.userId && p.userId !== "*" ? short(p.userId) : "todos"}`;
      return `${i === nextIdx ? "▶" : ""}${label}`;
    })
    .join(" › ");
}

module.exports = {
  buildCycle,
  expandPattern,
  nextExpandedIndex,
  canonType,
  canonPattern,
  NAMES,
  nextStepIndex,
  stepKey,
  infoOf,
  originLabel,
  cycleLine,
  LEGEND,
  MANUAL,
  LISTED,
  TYPE_INFO,
};