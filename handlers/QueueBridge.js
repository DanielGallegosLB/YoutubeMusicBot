const fs = require("fs");
const path = require("path");

// Puente bidireccional con el dashboard de ParadiseBot mediante archivos
// compartidos (misma idea que musicbot_events.txt):
//   →  musicbot_queue.json : snapshot de todas las colas activas (escribe JUGNU)
//   ←  musicbot_cmds.json  : comandos del dashboard (reordenar) que JUGNU aplica
const DASH_DIR = "C:/Users/Dani/Downloads/Proyectos/34-ParadiseBot-Economy/dashboard";
const QUEUE_FILE = path.join(DASH_DIR, "musicbot_queue.json");
const CMDS_FILE = path.join(DASH_DIR, "musicbot_cmds.json");

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
function queueView(client, guild) {
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
    }

    return {
      guildId: guild.id,
      guildName: guild.name || guild.id,
      voiceChannel: vc ? vc.name : null,
      autoDj: !!client.autoDj?.get(guild.id),
      repeatMode: queue.repeatMode || 0,
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

// Solo escribe si algo cambió (evita I/O y re-render inútiles).
function nowSignature(client) {
  let sig;
  try {
    const guilds = [];
    for (const guild of client.guilds.cache.values()) {
      const q = client.distube.getQueue(guild.id);
      if (!q || !q.songs || !q.songs.length) continue;
      guilds.push(guild.id + ":" + q.songs.map((s) => s.url || s.name).join("|"));
    }
    sig = guilds.join(";");
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
      const view = queueView(client, guild);
      if (view) guilds.push(view);
    }
    queueWrite(QUEUE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), guilds }));
  } catch {}
}

// Procesa los comandos que el dashboard dejó en musicbot_cmds.json.
// Formato: array de { action: "move", guildId, from, to } (índices 1-based,
// igual que /reordenar). Tras aplicar, reemplaza el archivo con [].
function processCommands(client) {
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
    if (!cmd || cmd.action !== "move" || !cmd.guildId) continue;
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
  setInterval(() => processCommands(client), CMDS_INTERVAL);
  setTimeout(() => writeSnapshot(client), 1500); // primer snapshot apenas inicie
};