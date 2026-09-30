const fs = require("fs");
const path = require("path");
const PlaylistStore = require("./PlaylistStore");

// Puente bidireccional con el dashboard de ParadiseBot mediante archivos
// compartidos (misma idea que musicbot_events.txt):
//   →  musicbot_queue.json : snapshot de todas las colas activas (escribe JUGNU)
//   ←  musicbot_cmds.json  : comandos del dashboard (reordenar/control) que JUGNU aplica
//   →  musicbot_favorites.json : lista de favoritas con estado de 👍/⭐ (para buscar/verificar likes)
//   ack musicbot_favclear_result.json : resultado del "quitar favoritas de todos"
//   ack musicbot_autodj_result.json  : resultado de cambiar el patrón / purgar basura
const DASH_DIR = "C:/Users/Dani/Downloads/Proyectos/34-ParadiseBot-Economy/dashboard";
const QUEUE_FILE = path.join(DASH_DIR, "musicbot_queue.json");
const CMDS_FILE = path.join(DASH_DIR, "musicbot_cmds.json");
const FAVORITES_FILE = path.join(DASH_DIR, "musicbot_favorites.json");
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
function songView(song) {
  if (!song) return null;
  return {
    url: song.url || null,
    name: song.name || song.title || "Sin título",
    uploader: (song.uploader && (song.uploader.name || song.uploader.url)) || "",
    duration: song.formattedDuration || song.duration || null,
    requestedBy:
      (song.user && (song.user.tag || song.user.username || song.user.displayName || "desconocido")) ||
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
        (await PlaylistStore.getAutoDjPattern(client, guild.id).catch(() => null)) ||
        PlaylistStore.DEFAULT_AUTODJ_PATTERN.map((s) => ({ ...s }));
      const listeners = vc
        ? [...vc.members.values()].filter((m) => m && !m.user?.bot)
        : [];
      const ids = listeners.map((m) => m.id);
      const pools = ids.length
        ? await PlaylistStore.getAutoDjPoolsByUser(client, guild.id, ids).catch(() => ({}))
        : {};
      autoDjUsers = listeners.map((m) => ({
        id: m.id,
        tag: m.user?.tag || m.user?.username || m.id,
        name: m.user?.globalName || m.user?.username || m.user?.tag || m.id,
        avatar: m.user?.displayAvatarURL?.() || null,
        liked: (pools[m.id] || []).length,
      }));
      favStats = await PlaylistStore.countUnlikedFavorites(client, guild.id).catch(() => null);
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
      actualPlaying: real ? songView({ ...real, name: real.name || real.title }) : null,
      nowPlaying: songView(queue.songs[0]),
      mismatch: mismatch || undefined,
      songs: queue.songs.slice(1).map((s) => songView(s)),
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
async function writeFavoritesSnapshot(client) {
  try {
    if (!client.music) return;
    const guilds = [];
    for (const guild of client.guilds.cache.values()) {
      const songs = await PlaylistStore.listGuildFavorites(client, guild.id).catch(() => []);
      if (!songs || !songs.length) continue;
      const users = {};
      const userIds = [...new Set(songs.map((s) => s.userId))];
      for (const uid of userIds) {
        const u = client.users?.cache?.get(uid) || null;
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

// Procesa los comandos que el dashboard dejó en musicbot_cmds.json.
// Formato: array de comandos. Soportados:
//   { action: "move", guildId, from, to }          → reordenar cola (índices 1-based)
//   { action: "clear_guild_favorites", guildId, t } → vaciar favoritas de todos
//   { action: "prune_unliked_favorites", guildId, t } → borrar SOLO la basura (DEFINITIVO)
//   { action: "set_autodj_pattern", guildId, pattern, t } → patrón de intercalado
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

    if (cmd.action === "clear_guild_favorites") {
      try {
        const res = await PlaylistStore.clearGuildFavorites(client, cmd.guildId);
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
        const res = await PlaylistStore.pruneUnlikedFavorites(client, cmd.guildId);
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
            case "skip":
              await queue.skip().catch(() => {});
              break;
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
          const res = await PlaylistStore.likeForUser(client, gid, uid, {
            url,
            name: song.name || song.title || null,
            title: song.title || song.name || null,
            thumbnail: song.thumbnail || null,
            uploader: song.uploader || null,
            duration: Number(song.duration) || 0,
            formattedDuration: song.formattedDuration ? String(song.formattedDuration) : null,
          });
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
          if (res) {
            _lastFavSig = "";       // refrescar snapshot de favoritas
            _lastSnapshotSig = "";  // refrescar pool del AutoDJ en el queue snapshot
            console.log(`[Bridge] 👍 Like manual para ${uid}: ${url} (creado=${!!res.created})`);
          } else {
            console.warn("[Bridge] Like_for_user devolvió null:", url);
          }
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
    processCommands(client).catch((e) => console.warn("[Bridge] processCommands:", e?.message || e));
  }, CMDS_INTERVAL);
  setTimeout(() => {
    writeSnapshot(client).catch(() => {});
    writeFavoritesSnapshot(client).catch(() => {});
  }, 1500); // primer snapshot apenas inicie
};