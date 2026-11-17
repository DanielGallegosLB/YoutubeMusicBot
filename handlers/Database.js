const { MONGO_URL } = require("../settings/config");
const { createStore } = require("./MemoryStore");
// MongoDB cuando hay MONGO_URL (Josh + @joshdb/mongo); si no, almacén en MEMORIA
// con escritura diferida a data/<nombre>/josh_0.json (handlers/MemoryStore.js).
const useMongo = !!(MONGO_URL && typeof MONGO_URL === "string" && MONGO_URL.trim().length);
let Josh = null;
let provider = null;
if (useMongo) {
  try {
    Josh = require("@joshdb/core");
    provider = require("@joshdb/mongo");
    console.log("[Database] Using MongoDB provider (@joshdb/mongo)");
  } catch (err) {
    Josh = null;
    provider = null;
    console.warn("[Database] MongoDB no disponible, usando almacén en memoria:", err?.message || err);
  }
}
if (!provider) console.log("[Database] Using in-memory store (handlers/MemoryStore.js)");
const MusicBot = require("./Client");
const { Events } = require("discord.js");
// const provider = require("@joshdb/mongo"); // Manual override example

/**
 * Initialize Josh database for music and autoresume
 * @param {MusicBot} client - Discord client instance
 */
module.exports = async (client) => {
  // Idempotente: si "ready" se dispara otra vez (reconexión), NO se recrean los stores
  // (el almacén en memoria perdería lo aún no guardado) ni se duplica el listener.
  if (client.__dbInit) return;
  client.__dbInit = true;

  // Initialize music and autoresume databases
  const dbName = (client.user?.username || "MusicBot").replace(/\s+/g, "");

  const dbOptions = {
    url: MONGO_URL,
    dbName: dbName,
  };

  if (provider && Josh) {
    client.music = new Josh({
      name: "music",
      provider,
      // ensureProps=false: sin esto, ensure("guild.playlists.user", {}) hace
      // internamente ensure("guild", {}) y REESCRIBE el documento entero del
      // gremio en CADA lectura. Esas escrituras, hechas fuera del lock con un
      // snapshot viejo, pisaban el likedBy.
      ensureProps: false,
      providerOptions: { ...dbOptions, collection: "music" },
    });
    client.autoresume = new Josh({
      name: "autoresume",
      provider,
      ensureProps: false,
      providerOptions: { ...dbOptions, collection: "autoresume" },
    });
  } else {
    const log = (m) => client.logger?.warn?.(m) ?? console.warn(m);
    client.music = createStore({ name: "music", log });
    client.autoresume = createStore({ name: "autoresume", log });
  }

  // Serialize writes per store to avoid JoshDB JSON rename collisions on Windows (EPERM).
  //
  // Cola propia (en vez de una cadena de promesas) con COALESCENCIA: si ya hay un set()
  // pendiente (aún no iniciado) para la MISMA clave, el nuevo valor reemplaza al viejo
  // en vez de apilarse. Cada set() pendiente retiene el documento entero del guild
  // (~700 KB, objetos creados por getFile al leerlo); si el disco se atasca (EPERM,
  // antivirus, OneDrive...) la cola crecía sin límite y esa memoria nunca se liberaba.
  // El estado final es idéntico: el último valor de una clave es el que gana.
  // No se combina nunca a través de una clave solapada (a / a.b), para no reordenar.
  const serializeWrites = (store, name) => {
    const originalSet = store.set.bind(store);
    const pending = [];
    const st = { name, pending: 0, maxPending: 0, coalesced: 0, writes: 0, failed: 0, runningSince: 0 };
    let running = false;

    const overlap = (a, b) => a === b || a.startsWith(b + ".") || b.startsWith(a + ".");

    const pump = async () => {
      if (running) return;
      running = true;
      try {
        while (pending.length) {
          const job = pending.shift();
          st.pending = pending.length;
          st.runningSince = Date.now();
          try {
            const res = await originalSet(...job.args);
            st.writes++;
            for (const w of job.waiters) w.resolve(res);
          } catch (e) {
            st.failed++;
            for (const w of job.waiters) w.reject(e);
          }
        }
      } finally {
        running = false;
        st.runningSince = 0;
      }
    };

    store.set = (...args) =>
      new Promise((resolve, reject) => {
        const key = typeof args[0] === "string" ? args[0] : null;
        if (key) {
          for (let i = pending.length - 1; i >= 0; i--) {
            const p = pending[i];
            if (!p.key) break;
            if (p.key === key) {
              p.args = args; // el valor más nuevo reemplaza al pendiente
              p.waiters.push({ resolve, reject });
              st.coalesced++;
              return;
            }
            if (overlap(p.key, key)) break; // no cruzar claves solapadas
          }
        }
        pending.push({ key, args, waiters: [{ resolve, reject }] });
        st.pending = pending.length;
        if (pending.length > st.maxPending) st.maxPending = pending.length;
        pump();
      });

    store.writeStats = () => ({
      ...st,
      pending: pending.length,
      stuckMs: st.runningSince ? Date.now() - st.runningSince : 0,
    });
  };

  // El almacén en memoria ya agrupa y serializa sus escrituras (y expone writeStats()).
  if (provider && Josh) {
    serializeWrites(client.music, "music");
    serializeWrites(client.autoresume, "autoresume");
  }

  // Handle guild deletion event
  client.on(Events.GuildDelete, async (guild) => {
    try {
      if (!guild) return;

      // Get music data for the guild
      const musicData = await client.music.get(guild.id);
      if (!musicData) return;

      // Delete request channel if exists
      const requestChannel = guild.channels.cache.get(musicData.music.channel);
      if (requestChannel) {
        await requestChannel.delete(
          `Deleting ${client.user?.username || "MusicBot"} Request Channel`
        );
      }

      // Delete music data for the guild
      await client.music.delete(guild.id);
    } catch (error) {
      console.error("Error handling guildDelete event:", error);
    }
  });
};
