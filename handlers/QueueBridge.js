const fs = require("fs");
const path = require("path");
const PlaylistStore = require("./PlaylistStore");

// Puente bidireccional con el dashboard de ParadiseBot mediante archivos
// compartidos (misma idea que musicbot_events.txt):
//   →  musicbot_queue.json : snapshot de todas las colas activas (escribe JUGNU)
//   ←  musicbot_cmds.json  : comandos del dashboard (reordenar/control) que JUGNU aplica
//   →  musicbot_favorites.json : lista de favoritas con estado de 👍/⭐ (para buscar/verificar likes)
//   →  musicbot_channels.json  : política de borrado de mensajes por guild (lo que muestra el dashboard)
//   ack musicbot_favclear_result.json : resultado del "quitar favoritas de todos"
//   ack musicbot_autodj_result.json  : resultado de cambiar el patrón / purgar basura
const DASH_DIR = "C:/Users/Dani/Downloads/Proyectos/34-ParadiseBot-Economy/dashboard";
const QUEUE_FILE = path.join(DASH_DIR, "musicbot_queue.json");
const CMDS_FILE = path.join(DASH_DIR, "musicbot_cmds.json");
const FAVORITES_FILE = path.join(DASH_DIR, "musicbot_favorites.json");
const CHANNELS_FILE = path.join(DASH_DIR, "musicbot_channels.json");
const CLEAR_RESULT_FILE = path.join(DASH_DIR, "musicbot_favclear_result.json");
const AUTODJ_RESULT_FILE = path.join(DASH_DIR, "musicbot_autodj_result.json");
const LIKE_RESULT_FILE = path.join(DASH_DIR, "musicbot_like_result.json");

const SNAPSHOT_INTERVAL = 5000; // ms
const CMDS_INTERVAL = 2000; // ms

// Escritura ASÍNCRONA (fs.promises + rename): jamás bloquea el event loop, que
// es lo que el streaming de audio (ffmpeg) usa para no cortarse.
let writing = Promise.resolve();
function queueWrite(file, data) {
  writing = writing.then(async () => {
    const tmp = file + ".tmp";
    await fs.promises.writeFile(tmp, data).catch(() => {});
    await fs.promises.rename(tmp, file).catch(() => {});
  }).catch(() => {});
}

// Serializa una canción de Distube a campos planos para el dashboard.
// `requestedBy` prefiere el usuario resuelto (tag/username). Si la canción solo
// guarda el `id` (song.user = { id } en sesiones restauradas / canciones del
// AutoDJ), se resuelve contra la caché del guild para NO mostrar un ID crudo.
function songView(song, guild) {
  if (!song) return null;
  let requester = song.user;
  if (requester && !requester.tag && !requester.username && requester.id && guild?.members?.cache) {
    const u = guild.members.cache.get(requester.id)?.user;
    if (u) requester = u;
  }
  return {
    url: song.url || null,
    name: song.name || song.title || "Sin título",
    uploader: (song.uploader && (song.uploader.name || song.uploader.url)) || "",
    duration: song.formattedDuration || song.duration || null,
    requestedBy:
      (requester && (requester.tag || requester.username || requester.displayName || "desconocido")) ||
      "desconocido",
    autoDj: !!song.autoDj,
  };
}

// Snapshot de la cola de un guild (indice 0 = canción sonando).
async function queueView(client, guild) {
  try {
    const queue = client.distube.getQueue(guild.id);
    if (!queue || !queue.songs || !queue.songs.length) return null;
    const vc =
      (queue.voice && queue.voice.connection && queue.voice.connection.channel) ||
      (guild.members && guild.members.me && guild.members.me.voice && guild.members.me.voice.channel) ||
      null;

    // Lo que DisTube está EMITIENDO de verdad (playSong) vs queue.songs[0], que
    // el autodj/bridge reordenan a mano. Sirve para diagnosticar el desfase
    // "el dashboard dice X pero suena Y".
    const real = client.actualPlaying && client.actualPlaying.get(guild.id);
    const expected = queue.songs[0];
    const playerStatus = queue.voice?.audioPlayer?.state?.status;
    const inTransition = playerStatus === "idle" || playerStatus === "buffering";
    const mismatch = !!(
      !inTransition && real && expected && real.url && expected.url && real.url !== expected.url
    );

    if (mismatch) {
      const now = Date.now();
      const lastLogged = client[`_jvb_mismatch_${guild.id}`];
      if (!lastLogged || now - lastLogged > 15000) {
        client[`_jvb_mismatch_${guild.id}`] = now;
        const realName = real.name || real.title;
        const first3 = queue.songs.slice(0, 5).map((s) => s?.name || "?").join(" | ");
        const line =
          `[Bridge] ⚠️ MISMATCH en ${guild.name}: DisTube EMITE "${realName}" (${real.url}) ` +
          `pero songs[0] dice "${expected.name}" (${expected.url}). ` +
          `Causa probable: reorden a mano (autodj / música) que movió songs[0] sin que DisTube lo haya reproducido todavía. ` +
          `[songs0..4: ${first3}]`;
        console.warn(line);
      }
      // Auto-heal: si DisTube está SONANDO "real" pero songs[0] es otra cosa,
      // la cola quedó desalineada por un reorden manual (autodj/música). Se
      // pide la canción real y se la pone al frente para que el dashboard y la
      // siguiente transición sigan en orden.
      try {
        const idx = queue.songs.findIndex((s, i) => i > 0 && s?.url && s.url === real.url && s.name === real.name);
        if (idx > 0) {
          const [song] = queue.songs.splice(idx, 1);
          queue.songs.unshift(song);
        }
      } catch (e) {}
    }

    // Datos para el editor visual del patrón de AutoDJ del dashboard:
    // el patrón vigente + los oyentes con cuántas canciones con like tienen.
    let autoDjPattern = null;
    let autoDjUsers = [];
    let favStats = null;
    try {
      autoDjPattern =
        (await withDbBounded(PlaylistStore.getAutoDjPattern(client, guild.id), 1800).catch(() => null)) ||
        PlaylistStore.DEFAULT_AUTODJ_PATTERN.map((s) => ({ ...s }));
      const listeners = vc
        ? [...vc.members.values()].filter((m) => m && !m.user?.bot)
        : [];
      const ids = listeners.map((m) => m.id);
      const pools = ids.length
        ? (await withDbBounded(PlaylistStore.getAutoDjPoolsByUser(client, guild.id, ids), 2200).catch(() => ({}))) || {}
        : {};
      autoDjUsers = listeners.map((m) => ({
        id: m.id,
        tag: m.user?.tag || m.user?.username || m.id,
        name: m.user?.globalName || m.user?.username || m.user?.tag || m.id,
        avatar: m.user?.displayAvatarURL?.() || null,
        liked: (pools[m.id] || []).length,
      }));
      favStats = await withDbBounded(PlaylistStore.countUnlikedFavorites(client, guild.id), 1800).catch(() => null);
    } catch {}

    return {
      guildId: guild.id,
      guildName: guild.name || guild.id,
      voiceChannel: vc ? vc.name : null,
      autoDj: !!client.autoDj?.get(guild.id),
      autoDjPattern,
      autoDjUsers,
      favStats,
      repeatMode: queue.repeatMode || 0,
      paused: !!queue.paused,
      volume: typeof queue.volume === "number" ? queue.volume : null,
      currentTime: Math.floor(Number(queue.currentTime) || 0),
      duration: Number(queue.songs[0]?.duration) || 0,
      actualPlaying: real ? songView({ ...real, name: real.name || real.title }, guild) : null,
      nowPlaying: songView(queue.songs[0], guild),
      mismatch: mismatch || undefined,
      songs: queue.songs.slice(1).map((s) => songView(s, guild)),
    };
  } catch {
    return null;
  }
}

let _lastSnapshotSig = ""; // firma del último snapshot escrito

// Solo escribe si algo cambió (evita I/O y re-render inútiles). El bucket de
// 30s fuerza un refresco periódico aunque la cola no cambie, para que el
// dashboard vea los likes/contadores del AutoDJ al instante.
function nowSignature(client) {
  let sig;
  try {
    const guilds = [];
    for (const guild of client.guilds.cache.values()) {
      const q = client.distube.getQueue(guild.id);
      if (!q || !q.songs || !q.songs.length) continue;
      guilds.push(guild.id + ":" + q.songs.map((s) => s.url || s.name).join("|"));
    }
    sig = guilds.join(";") + "|" + Math.floor(Date.now() / 30000);
  } catch {
    sig = "";
  }
  return sig;
}

async function writeSnapshot(client) {
  try {
    if (!client.distube) return;
    const sig = nowSignature(client);
    if (sig === _lastSnapshotSig) return;
    _lastSnapshotSig = sig;
    const guilds = [];
    for (const guild of client.guilds.cache.values()) {
      const view = await queueView(client, guild);
      if (view) guilds.push(view);
    }
    queueWrite(QUEUE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), guilds }));
  } catch {}
}

// ── Snapshot de favoritas (para "buscar canciones / verificar likes") ──
// Lista las "Canciones Favoritas" de TODOS los usuarios de cada guild con su
// estado de 👍/👎/⭐/plays. Se consulta en cada tick pero solo se escribe si
// cambió (los likes son raros: no gastar I/O ni re-renders a cada rato).
let _lastFavSig = "";
// Acota un await de base de datos: si Mongo/josh se cuelga (reconexión, lock) un
// .get()/set() puede no resolver NUNCA y eso congela los intervalos de snapshot
// → el dashboard se queda "fijo" con datos viejos. Con tope, el tick siempre
// termina y sigue con lo que ya tiene (la DB lenta resuelve sola en el fondo).
const withDbBounded = (p, ms) =>
  Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r(null), ms))]);

async function writeFavoritesSnapshot(client) {
  try {
    if (!client.music) return;
    const guilds = [];
    for (const guild of client.guilds.cache.values()) {
      const songs = await withDbBounded(
        PlaylistStore.listGuildFavorites(client, guild.id),
        4500
      ).catch(() => []);
      if (!Array.isArray(songs) || !songs.length) continue;
      const users = {};
      const userIds = [...new Set(songs.map((s) => s.userId))];
      if (!client._favUserName) client._favUserName = new Map();
      if (!client._favUserFetching) client._favUserFetching = new Set();
      for (const uid of userIds) {
        let u = client.users?.cache?.get(uid) || guild.members?.cache?.get(uid)?.user || null;
        if (!u && client._favUserName.has(uid)) {
          u = { username: client._favUserName.get(uid), tag: client._favUserName.get(uid) };
        } else if (!u && !client._favUserFetching.has(uid)) {
          // Al arrancar el bot, client.users.cache está VACÍO: se resuelve el
          // nombre en segundo plano y queda cacheado para el próximo tick.
          client._favUserFetching.add(uid);
          client.users
            .fetch(uid)
            .then((fu) => {
              client._favUserName.set(uid, fu.username || fu.tag || uid);
              client._favUserFetching.delete(uid);
            })
            .catch(() => client._favUserFetching.delete(uid));
        }
        users[uid] = {
          id: uid,
          tag: u ? (u.tag || u.username || uid) : uid,
          name: u ? (u.globalName || u.username || u.tag || uid) : uid,
          avatar: u?.displayAvatarURL?.() || null,
        };
      }
      guilds.push({ guildId: guild.id, guildName: guild.name || guild.id, users, songs });
    }
    const payload = { updatedAt: new Date().toISOString(), guilds };
    const sig = JSON.stringify(payload);
    if (sig === _lastFavSig) return;
    _lastFavSig = sig;
    queueWrite(FAVORITES_FILE, JSON.stringify(payload));
  } catch {}
}

// ── Snapshot de la política de borrado de mensajes ──
// Lo que el dashboard muestra en "Canales de mensajes" y sobre lo que escribe
// al aplicar un cambio ({ action: "set_channels" }).
let _lastChannelsSig = "";
async function writeChannelsSnapshot(client) {
  try {
    if (!client.music) return;
    const guilds = [];
    for (const guild of client.guilds.cache.values()) {
      try {
        const policy = await withDbBounded(client.getChannelPolicy(guild.id), 3000).catch(() => null);
        const meta = await withDbBounded(client.music.get(`${guild.id}.music`), 3000).catch(() => null);
        if (!policy) continue;
        guilds.push({
          guildId: guild.id,
          guildName: guild.name || guild.id,
          cleanup: policy.cleanup,
          noCleanup: policy.noCleanup,
          // Canal del reproductor (data.channel): entra solo en la limpieza.
          playerChannel: meta?.channel ? String(meta.channel) : null,
          previewChannel: client.config?.channels?.preview || null,
          ephemeralTTL: client.config?.options?.ephemeralTTL ?? 10000,
          cleanupTTL: client.config?.options?.cleanupTTL ?? 10000,
          custom: Array.isArray(meta?.cleanupChannels) || Array.isArray(meta?.noCleanupChannels),
        });
      } catch {}
    }
    const payload = {
      updatedAt: new Date().toISOString(),
      guilds,
      defaults: {
        cleanup: client.config?.channels?.cleanup ?? null,
        noCleanup: client.config?.channels?.noCleanup ?? [],
        preview: client.config?.channels?.preview ?? null,
      },
    };
    const sig = JSON.stringify(payload);
    if (sig === _lastChannelsSig) return;
    _lastChannelsSig = sig;
    queueWrite(CHANNELS_FILE, JSON.stringify(payload));
  } catch {}
}

// Procesa los comandos que el dashboard dejó en musicbot_cmds.json.
// Formato: array de comandos. Soportados:
//   { action: "move", guildId, from, to }          → reordenar cola (índices 1-based)
//   { action: "clear_guild_favorites", guildId, t } → vaciar favoritas de todos
//   { action: "prune_unliked_favorites", guildId, t } → borrar SOLO la basura (DEFINITIVO)
//   { action: "set_autodj_pattern", guildId, pattern, t } → patrón de intercalado
//   { action: "set_channels", guildId, cleanup, noCleanup, t } → canales de borrado
// Tras aplicar, reemplaza el archivo con [].
async function processCommands(client) {
  let cmds = [];
  try {
    if (fs.existsSync(CMDS_FILE)) {
      const raw = fs.readFileSync(CMDS_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) cmds = parsed.slice(0, 50);
    }
  } catch {
    return;
  }
  if (!cmds.length) return;

  const queueCache = new Map();
  for (const cmd of cmds) {
    if (!cmd || !cmd.guildId) continue;

    // Canales de borrado de mensajes, editables desde el dashboard.
    // { action: "set_channels", guildId, cleanup, noCleanup, t }
    //   cleanup:   array de IDs (o "" para volver al default del config)
    //   noCleanup: array de IDs intocables (gana sobre cleanup)
    if (cmd.action === "set_channels") {
      try {
        const toList = (v) =>
          (Array.isArray(v) ? v : v ? [v] : [])
            .map((id) => String(id).trim())
            .filter((id) => /^\d{15,25}$/.test(id));
        const cleanup = toList(cmd.cleanup);
        const noCleanup = toList(cmd.noCleanup);
        // El canal del reproductor se limpia siempre, salvo que el admin lo
        // marque como intocable.
        const meta = await client.music?.get(`${cmd.guildId}.music`).catch(() => null);
        const playerChannel = meta?.channel ? String(meta.channel) : null;

        if (cleanup.length) await client.music.set(`${cmd.guildId}.music.cleanupChannels`, cleanup);
        else await client.music.set(`${cmd.guildId}.music.cleanupChannels`, []);

        if (noCleanup.length) await client.music.set(`${cmd.guildId}.music.noCleanupChannels`, noCleanup);
        else await client.music.set(`${cmd.guildId}.music.noCleanupChannels`, []);

        client._channelPolicyCache?.delete(String(cmd.guildId));
        _lastChannelsSig = ""; // fuerza refresco del snapshot de canales
        const effective = await client.getChannelPolicy(cmd.guildId).catch(() => null);
        console.log(
          `[Bridge] Canales G:${cmd.guildId}: limpieza=[${(effective?.cleanup || []).join(", ")}] ` +
            `intocables=[${(effective?.noCleanup || []).join(", ")}] (panel=${playerChannel})`
        );
      } catch (e) {
        console.warn("[Bridge] Error al guardar los canales:", e?.message || e);
      }
      continue;
    }

    if (cmd.action === "clear_guild_favorites") {
      try {
        const res = (await withDbBounded(PlaylistStore.clearGuildFavorites(client, cmd.guildId), 12000).catch(() => null)) || { removed: 0, users: 0 };
        client.invalidateQueueCaches?.(cmd.guildId);
        queueWrite(
          CLEAR_RESULT_FILE,
          JSON.stringify({
            requestedAt: cmd.t || null,
            doneAt: new Date().toISOString(),
            guildId: cmd.guildId,
            removed: res.removed || 0,
            users: res.users || 0,
          })
        );
      } catch (e) {
        console.warn("[Bridge] Error al limpiar favoritas:", e?.message || e);
      }
      continue;
    }

    // Botón "eliminar basura" del dashboard: BORRA de las favoritas las canciones
    // que nadie tiene con like y que no se guardaron a mano (⭐). Es definitivo.
    if (cmd.action === "prune_unliked_favorites") {
      try {
        const res = (await withDbBounded(PlaylistStore.pruneUnlikedFavorites(client, cmd.guildId), 12000).catch(() => null)) || { removed: 0, users: 0, kept: 0 };
        client.invalidateQueueCaches?.(cmd.guildId);
        queueWrite(
          AUTODJ_RESULT_FILE,
          JSON.stringify({
            kind: "prune",
            requestedAt: cmd.t || null,
            doneAt: new Date().toISOString(),
            guildId: cmd.guildId,
            ok: true,
            removed: res.removed || 0,
            users: res.users || 0,
            kept: res.kept || 0,
          })
        );
        console.log(
          `[Bridge] Favoritas G:${cmd.guildId}: se eliminaron ${res.removed} sin like de ${res.users} usuarios (quedan ${res.kept} reales)`
        );
        _lastSnapshotSig = ""; // fuerza refresco del snapshot
      } catch (e) {
        console.warn("[Bridge] Error al eliminar basura:", e?.message || e);
        queueWrite(
          AUTODJ_RESULT_FILE,
          JSON.stringify({ kind: "prune", requestedAt: cmd.t || null, guildId: cmd.guildId, ok: false, error: e?.message || String(e) })
        );
      }
      continue;
    }

    // Editor visual del patrón de intercalado del AutoDJ.
    if (cmd.action === "set_autodj_pattern") {
      try {
        const pattern = await PlaylistStore.setAutoDjPattern(client, cmd.guildId, cmd.pattern);
        queueWrite(
          AUTODJ_RESULT_FILE,
          JSON.stringify({
            kind: "pattern",
            requestedAt: cmd.t || null,
            doneAt: new Date().toISOString(),
            guildId: cmd.guildId,
            ok: true,
            pattern: pattern || PlaylistStore.DEFAULT_AUTODJ_PATTERN.map((s) => ({ ...s })),
          })
        );
        console.log(
          `[Bridge] Patrón AutoDJ G:${cmd.guildId}: ` +
            (pattern || []).map((p) => (p.type === "random" ? "aleatoria" : `rec:${p.userId}`)).join(" > ") || "(default)"
        );
        _lastSnapshotSig = ""; // fuerza refresco del snapshot
        // Reordenar ya con el patrón nuevo (el próximo refill también lo usa).
        const q = client.distube.getQueue(cmd.guildId);
        if (q) client.autoDjRefill(q, { force: false }).catch(() => {});
      } catch (e) {
        console.warn("[Bridge] Error al setear el patrón de AutoDJ:", e?.message || e);
        queueWrite(
          AUTODJ_RESULT_FILE,
          JSON.stringify({ kind: "pattern", requestedAt: cmd.t || null, guildId: cmd.guildId, ok: false, error: e?.message || String(e) })
        );
      }
      continue;
    }

    // Controles de reproducción desde el dashboard: escribe
    // { action: "queue_control", sub, value?, guildId } y el bot lo aplica a la
    // cola exactamente como si hubieran apretado el botón en Discord.
    if (cmd.action === "queue_control") {
      try {
        const queue = client.distube.getQueue(cmd.guildId);
        const sub = cmd.sub;
        if (queue && queue.songs?.length) {
          switch (sub) {
            case "pause":
              if (!queue.paused) queue.pause();
              break;
            case "resume":
              if (queue.paused) queue.resume();
              break;
            case "skip": {
              // El skip del dashboard también cuenta: se atribuye al admin de
              // Discord que lo ordenó (cmd.userId) para que el AutoDJ le elija
              // menos esa canción.
              const cur = queue.songs?.[0];
              if (cur?.url && cmd.userId) {
                PlaylistStore.recordTrackSkip(client, cmd.guildId, cmd.userId, cur)
                  .then((n) => {
                    client.logger?.log(
                      `[Skip] ${cmd.userId} saltó "${cur.name || cur.url}" desde el dashboard → ${n} skip(s) (G:${cmd.guildId})`
                    );
                  })
                  .catch(() => {});
              }
              await queue.skip().catch(() => {});
              break;
            }
            case "previous":
              await queue.previous().catch(() => {});
              break;
            case "rewind":
              queue.seek(Math.max(0, (Number(queue.currentTime) || 0) - 10));
              break;
            case "forward":
              queue.seek((Number(queue.currentTime) || 0) + 10);
              break;
            case "seek":
              queue.seek(Math.max(0, Number(cmd.value) || 0));
              break;
            case "shuffle":
              queue.shuffle();
              break;
            case "loop": {
              const v = String(cmd.value || "off");
              queue.setRepeatMode(v === "song" ? 1 : v === "queue" ? 2 : 0);
              break;
            }
            case "volume": {
              queue.setVolume(Math.max(0, Math.min(150, Number(cmd.value) || 0)));
              break;
            }
            case "stop": {
              queue.songs = [];
              await queue.stop().catch(() => {});
              client.autoDjDisable?.(cmd.guildId);
              const g = client.guilds.cache.get(cmd.guildId);
              if (g) client.distube.voices.leave(g).catch(() => {});
              break;
            }
            default:
              break;
          }
          client.updatequeue(queue).catch(() => {});
          client.updateplayer(queue).catch(() => {});
          console.log(`[Bridge] Control "${sub}" G:${cmd.guildId} desde el dashboard`);
        }
        _lastSnapshotSig = ""; // fuerza refresco fresco del snapshot
      } catch (e) {
        console.warn("[Bridge] Error en control musical:", e?.message || e);
      }
      continue;
    }

    // 👍 Like en nombre de un usuario (panel "usuarios" del dashboard): agrega
    // la canción a sus "Canciones Favoritas" (si no está) y le pone un like, para
    // que el AutoDJ de ESE usuario tenga una recomendación 🛸 más.
    // Formato: { action: "like_for_user", guildId, userId, url, song?, t }
    if (cmd.action === "like_for_user") {
      const gid = String(cmd.guildId || "");
      const uid = String(cmd.userId || "");
      const url = String(cmd.url || "");
      if (gid && uid && /^https?:\/\//.test(url)) {
        try {
          const song = (cmd.song && typeof cmd.song === "object") ? cmd.song : {};
          // El dashboard es acción manual del admin: cada 👍 SUMA, sin tope por
          // reproducción. (El tope "1 por usuario por reproducción" es solo del
          // botón del embed.) Por eso NO se pasa claimKey.
          const res = await withDbBounded(PlaylistStore.likeForUser(client, gid, uid, {
            url,
            name: song.name || song.title || null,
            title: song.title || song.name || null,
            thumbnail: song.thumbnail || null,
            uploader: song.uploader || null,
            duration: Number(song.duration) || 0,
            formattedDuration: song.formattedDuration ? String(song.formattedDuration) : null,
          }), 15000);
          if (res) {
            _lastFavSig = "";       // refrescar snapshot de favoritas
            _lastSnapshotSig = "";  // refrescar pool del AutoDJ en el queue snapshot
            client.invalidateQueueCaches?.(gid);
            // Escribir YA el snapshot de favoritas ANTES del ACK (no esperar al
            // intervalo): el dashboard, al recibir el ACK y reabrir el panel, ya
            // ve el 👍 actualizado (sin la carrera de 900ms vs 5s).
            await writeFavoritesSnapshot(client).catch(() => {});
            console.log(`[Bridge] 👍 Like manual para ${uid}: ${url} (creado=${!!res.created}, total=${res.likeCount}${res.alreadyThisPlay ? ", ya contado en esta reproducción" : ""})`);
          } else {
            console.warn("[Bridge] Like_for_user devolvió null:", url);
          }
          queueWrite(
            LIKE_RESULT_FILE,
            JSON.stringify({
              requestedAt: cmd.t || null,
              doneAt: new Date().toISOString(),
              guildId: gid,
              userId: uid,
              url,
              ok: !!res,
              created: !!res?.created,
              likeCount: res?.likeCount || 1,
              score: res?.score || 1,
            })
          );
        } catch (e) {
          console.warn("[Bridge] Error en like_for_user:", e?.message || e);
          queueWrite(
            LIKE_RESULT_FILE,
            JSON.stringify({
              requestedAt: cmd.t || null,
              doneAt: new Date().toISOString(),
              guildId: gid,
              userId: uid,
              url,
              ok: false,
              error: e?.message || String(e),
            })
          );
        }
      }
      continue;
    }

    if (cmd.action !== "move") continue;
    const from = cmd.from;
    const to = cmd.to;
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    if (from < 1 || to < 1) continue;

    try {
      let queue = queueCache.get(cmd.guildId);
      if (!queue) {
        queue = client.distube.getQueue(cmd.guildId);
        queueCache.set(cmd.guildId, queue);
      }
      if (!queue || !queue.songs) continue;
      if (from >= queue.songs.length) continue;
      if (from === to) continue;

      // Ajuste de índice si el movimiento ya corrió la posición objetivo.
      let target = Math.max(1, Math.min(to, queue.songs.length - 1));
      const song = queue.songs[from];
      queue.songs.splice(from, 1);
      queue.songs.splice(target, 0, song);

      client.updatequeue(queue).catch(() => {});
      client.updateplayer(queue).catch(() => {});
    } catch {}
  }

  queueWrite(CMDS_FILE, "[]");
}

module.exports = (client) => {
  setInterval(() => writeSnapshot(client), SNAPSHOT_INTERVAL);
  setInterval(() => {
    writeFavoritesSnapshot(client).catch((e) => console.warn("[Bridge] favorites:", e?.message || e));
  }, SNAPSHOT_INTERVAL);
  setInterval(() => {
    writeChannelsSnapshot(client).catch((e) => console.warn("[Bridge] channels:", e?.message || e));
  }, 10000);
  setInterval(() => {
    processCommands(client).catch((e) => console.warn("[Bridge] processCommands:", e?.message || e));
  }, CMDS_INTERVAL);
  setTimeout(() => {
    writeSnapshot(client).catch(() => {});
    writeFavoritesSnapshot(client).catch(() => {});
  }, 1500); // primer snapshot apenas inicie
  // El snapshot de canales espera un poco más: getChannelPolicy lee la DB de
  // música y los canales no cambian seguido.
  setTimeout(() => writeChannelsSnapshot(client).catch(() => {}), 4000);
};