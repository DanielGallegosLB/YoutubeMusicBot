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
 *   7. 🎲 aleatoria de la lista         (random)
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
  "🛸 recomendada · 🎲 aleatoria (pedidas / lista) · 🎤 novedosa · 📝 pedidas · 🎵 manual · 📋 de la lista cargada";

// Cuando un paso no encontró lo suyo y cayó a otra fuente, se dice en el rótulo.
const FALLBACK_TAG = { sala: "↩ sala", reciclada: "↩ reciclada", rescate: "↩ rescate", lista: "↩ lista" };

/** Ciclo completo para estos oyentes (en el orden pedido). */
function buildCycle(listeners) {
  const order = (listeners || []).filter(Boolean);
  const out = [];
  for (const uid of order) out.push({ type: "liked", userId: uid });
  for (const uid of order) out.push({ type: "aleatorias", userId: uid });
  for (const uid of order) out.push({ type: "artistas", userId: uid });
  out.push({ type: "random" });
  return out;
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
      return `${info.icon} ${info.tag === "Lista" ? "Aleat. lista" : info.tag}`;
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
      const label = p.type === "random" ? `${info.icon}lista` : `${info.icon}${short(p.userId)}`;
      return `${i === nextIdx ? "▶" : ""}${label}`;
    })
    .join(" › ");
}

module.exports = {
  buildCycle,
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