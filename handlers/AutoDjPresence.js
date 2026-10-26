/**
 * Presencia en el canal de voz ↔ recomendaciones del AutoDJ.
 *
 * Cuando alguien se va del canal, sus recomendaciones (las canciones que el
 * bot le encoló como "🛸/👍/📝 de fulano") tienen que irse con él: si se
 * quedan, la cola sigue reservando huecos para un usuario que ya no está y el
 * AutoDJ sigue metiendo temas suyos.
 *
 * Solo se borran las canciones que ENCOLÓ el bot para él (`_autoDjAdded`).
 * Las que el usuario puso con su propia lista se quedan (son suyas), pero
 * pierden el rótulo de "recomendación de <usuario>".
 */

/** ¿La canción de la cola es una recomendación del AutoDJ? */
const isAutoDjSong = (s) => !!(s && (s.autoDj || s._autoDj));

/** ¿La canción de la cola es la recomendación de ese usuario? */
const isRecFor = (s, userId) =>
  isAutoDjSong(s) && !!userId && s.autoDjUserId === userId;

/**
 * Quita de la cola las recomendaciones que el bot le hizo a un usuario que ya
 * no está en el canal y reabastece los huecos con los que siguen ahí.
 *
 * La que está SONANDO no se puede sacar de la cola: sólo pierde el rótulo.
 *
 * @param {import("./Client")} client
 * @param {import("discord.js").Guild} guild
 * @param {string} userId usuario que se va del canal
 * @returns {Promise<number>} cuántas recomendaciones se quitaron de la cola
 */
async function removeUserRecommendations(client, guild, userId) {
  const guildId = guild?.id;
  if (!guildId || !userId) return 0;

  // Quitar por defecto las canciones que el bot añadió para ese usuario al salir.
  if (process.env.AUTODJ_REMOVE_ON_LEAVE === "0") return 0;

  const queue = client.distube?.getQueue(guildId);
  if (!queue || !queue.songs?.length) return 0;

  let removed = 0;
  const kept = [];
  for (let i = 0; i < queue.songs.length; i++) {
    const s = queue.songs[i];
    // songs[0] es la que está sonando: no se puede quitar de la cola.
    // Quitar todas las que el bot añadió para ese usuario (recomendación/aleatoria/artistas/pedidas)
    if (i === 0 || !isRecFor(s, userId)) {
      kept.push(s);
      continue;
    }
    // Si ya estaba en cola (no la añadió el bot ahora), mantenerla pero sin rótulo
    if (s._autoDjAdded !== true) {
      kept.push(s);
      continue;
    }
    removed++;
  }

  // Lo que queda deja de llevar el rótulo del que se fue
  for (const s of queue.songs) if (isRecFor(s, userId)) s.autoDjUserId = null;

  if (!removed) return 0;
  queue.songs = kept;

  try {
    client.logger.log(
      `[AutoDJ] G:${guildId} ${userId} se fue del canal: ${removed} recomendación(es) suya(s) fuera de la cola.`
    );
  } catch {}

  // Los huecos que dejó se rellenan con las recomendaciones de los que siguen.
  const fire = (fn, arg) => {
    try {
      const p = fn?.(arg);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  };
  fire(client.autoDjRefill, queue);
  fire(client.updatequeue, queue);
  fire(client.updateplayer, queue);
  return removed;
}

module.exports = { removeUserRecommendations };