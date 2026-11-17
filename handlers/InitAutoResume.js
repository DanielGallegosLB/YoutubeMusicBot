const { Queue } = require("distube");
const MusicBot = require("./Client");

/**
 * Builds a simplified track object from the original track object.
 * @param {Object} track - The original track object.
 * @returns {Object} The simplified track object.
 */
const buildTrack = (track) => {
  if (!track) return null;
  return {
    memberId: track.member?.id ?? track.user?.id ?? null,
    source: track.source,
    duration: track.duration,
    formattedDuration: track.formattedDuration,
    id: track.id,
    isLive: track.isLive,
    name: track.name,
    thumbnail: track.thumbnail,
    type: "video",
    uploader: track.uploader,
    url: track.url,
    views: track.views,
  };
};

/**
 * Automatically stores the state of the queue for auto-resume.
 * @param {MusicBot} client - The client instance.
 * @param {Queue} queue - The queue instance.
 */
module.exports = async (client, queue) => {
  // Limpiar el timer anterior del mismo guild: initQueue corre en CADA sesión
  // nueva y, sin esto, se acumulan decenas de intervalos (el "se queda pegado").
  const guildKey = queue.textChannel?.guildId || queue.textChannel?.guild?.id || "x";
  if (!client._autoresumeTimers) client._autoresumeTimers = new Map();
  if (client._autoresumeTimers.has(guildKey)) {
    clearInterval(client._autoresumeTimers.get(guildKey));
  }

  // Estado ya guardado, en memoria, por guild. Antes cada tick (10 s) releía el JSON de
  // `music` (~700 KB) y el de `autoresume`, y comparaba las canciones POR REFERENCIA
  // (arraysEqual con !==: objetos del disco vs. instancias Song => siempre "distinto"),
  // así que reescribía la lista entera de canciones en CADA tick. Eso eran decenas de
  // lecturas/escrituras de disco por minuto (y los EPERM de Windows al renombrar).
  if (!client._autoresumeCache) client._autoresumeCache = new Map();
  client._autoresumeCache.delete(guildKey); // sesión nueva => se revalida contra el disco
  const TIME_MS = Number(process.env.AUTORESUME_TIME_MS) || 30000; // cada cuánto se guarda currentTime
  const REVALIDATE_MS = 300000; // cada 5 min se vuelve a contrastar con el disco
  const songsKeyOf = (arr) => (Array.isArray(arr) ? arr.map((t) => t?.url || t?.id || "").join("|") : "");

  const timer = setInterval(async () => {
    try {
      const gid = queue.textChannel.guildId;
      if (client.playlistStopped?.get?.(gid)) {
        client._autoresumeCache.delete(gid);
        await client.autoresume.delete(gid).catch(() => {});
        return;
      }
      const newQueue = client.distube.getQueue(queue.textChannel.guild);
      if (!newQueue) return;

      // Flag "autoresume" del guild: se consulta como mucho 1 vez por minuto.
      const now = Date.now();
      let st = client._autoresumeCache.get(gid);
      if (!st || now - st.flagAt > 60000) {
        const flag = await client.music.get(`${gid}.autoresume`);
        st = client._autoresumeCache.get(gid) || st || { at: 0, props: null, songsKey: null, timeAt: 0 };
        st.flag = !!flag;
        st.flagAt = now;
        client._autoresumeCache.set(gid, st);
      }
      if (!st.flag) return;

      const songsArr = newQueue.songs.length > 0 ? newQueue.songs.map(buildTrack).filter(Boolean) : [];
      const autoresumeData = {
        guild: gid || null,
        voiceChannel: newQueue.voiceChannel?.id || null,
        textChannel: newQueue.textChannel?.id || null,
        songs: songsArr,
        volume: newQueue.volume || 100,
        repeatMode: newQueue.repeatMode || 0,
        playing: newQueue.playing || false,
        currentTime: newQueue.currentTime || 0,
        autoplay: newQueue.autoplay || false,
      };

      // Primera vez (o revalidación): lo guardado en disco es la referencia.
      if (!st.props || now - st.at > REVALIDATE_MS) {
        await client.autoresume.ensure(gid, autoresumeData);
        const storedData = await client.autoresume.get(gid);
        if (!storedData) { st.props = null; return; }
        st.props = {};
        for (const k of ["guild", "voiceChannel", "textChannel", "volume", "repeatMode", "playing", "currentTime", "autoplay"]) st.props[k] = storedData[k];
        st.songsKey = songsKeyOf(storedData.songs);
        st.at = now;
      }

      // Propiedades simples (currentTime, como mucho cada TIME_MS). Sin await y con
      // catch: antes un EPERM aquí salía como "Unhandled Rejection".
      for (const property of ["guild", "voiceChannel", "textChannel", "volume", "repeatMode", "playing", "currentTime", "autoplay"]) {
        if (st.props[property] === autoresumeData[property]) continue;
        if (property === "currentTime" && now - st.timeAt < TIME_MS) continue;
        const val = autoresumeData[property];
        if (property === "currentTime") st.timeAt = now;
        client.autoresume
          .set(`${gid}.${property}`, val)
          .then(() => { st.props[property] = val; })
          .catch(() => {});
      }

      // Canciones: solo si la lista cambió de verdad (por url), no en cada tick.
      const key = songsKeyOf(songsArr);
      if (key !== st.songsKey) {
        await client.autoresume.set(`${gid}.songs`, songsArr);
        st.songsKey = key;
      }
    } catch (error) {
      // No dejar que un fallo de autoresume tire un unhandled rejection
      console.error(`[AutoResume ${guildKey}] Error al guardar estado:`, error?.message || error);
    }
  }, 10000); // Interval for checking every 10 seconds

  // Solo UN timer por guild (el botón Stop reinicia la sesión y, sin esto, se
  // acumulan intervalos que spamean y "pegan" el proceso).
  client._autoresumeTimers.set(guildKey, timer);
};