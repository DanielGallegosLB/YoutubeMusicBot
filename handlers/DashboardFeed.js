const fs = require("fs");

// Archivo compartido con el dashboard: cada línea es un JSON que el dashboard
// lee e ingiere en botlogs (módulo MUSIC) para mostrar la actividad del bot de
// música en el feed en vivo. Ruta absoluta porque ambos procesos corren acá.
const FILE = "C:/Users/Dani/Downloads/Proyectos/34-ParadiseBot-Economy/dashboard/musicbot_events.txt";

// Acción legible (3a persona) por comando de barra.
const CMD_LABEL = {
  play: "reprodujo música",
  pplay: "reprodujo música en la sala",
  search: "buscó una canción",
  pause: "pausó la música",
  resume: "reanudó la música",
  stop: "detuvo la música",
  skip: "saltó a la siguiente canción",
  previous: "volvió a la canción anterior",
  loop: "cambió el modo de bucle",
  shuffle: "mezcló la cola de reproducción",
  autoplay: "cambió la reproducción automática",
  volume: "cambió el volumen",
  vol: "cambió el volumen",
  lyrics: "consultó la letra de la canción",
  queue: "revisó la cola de reproducción",
  nowplaying: "consultó qué está sonando",
  save: "guardó la canción en sus listas",
  list: "consultó sus listas",
  playlist: "reprodujo una lista guardada",
};

// Acción legible por botón del reproductor.
const BTN_LABEL = {
  previous: "volvió a la canción anterior",
  rewind10: "retrocedió 10 segundos",
  pauseresume: "pausó o reanudó la reproducción",
  forward10: "avanzó 10 segundos",
  skip: "saltó a la siguiente canción",
  stop: "detuvo la música",
  shuffle: "mezcló la cola de reproducción",
  loop_song: "cambió el bucle de la canción",
  loop_queue: "cambió el bucle de la cola",
  autoplay: "cambió la reproducción automática",
  savecurrent_btn: "guardó la canción en sus listas",
  autodj: "activó o desactivó el Auto DJ",
};

function push(ev) {
  try {
    fs.appendFileSync(FILE, JSON.stringify(ev) + "\n");
  } catch {}
}

function userOf(interaction) {
  try {
    const member = interaction.member;
    const name =
      (member && (member.displayName || member.nickname)) ||
      (interaction.user && interaction.user.username) ||
      "usuario";
    return String(name).slice(0, 60);
  } catch {
    return "usuario";
  }
}

function base(interaction) {
  return {
    t: new Date().toISOString(),
    module: "MUSIC",
    level: "INFO",
    variables: {
      user: userOf(interaction),
      userName: userOf(interaction),
      guild: (interaction.guild && interaction.guild.name) || "",
    },
    guildID: (interaction.guild && interaction.guild.id) || null,
  };
}

// Comando de barra con subargumentos (el último texto suele ser la canción).
function logCommand(cmd, interaction, args) {
  try {
    if (!interaction || !interaction.guild || (interaction.user && interaction.user.bot)) return;
    const key = String(cmd || "").toLowerCase();
    const label = CMD_LABEL[key] || `usó el comando /${cmd}`;
    const argsStr = (args || []).filter((a) => typeof a === "string" && a.trim() && !/^\d+$/.test(a)).slice(-1)[0] || "";
    const song =
      /^(play|pplay|search)$/i.test(key) && argsStr.trim()
        ? ` («${String(argsStr).trim().slice(0, 80)}»${key === "search" ? "?" : ""})`
        : "";
    const ev = base(interaction);
    ev.message = `${label}${song}`;
    ev.variables.cmd = String(cmd || "");
    push(ev);
  } catch {}
}

// Botones del reproductor en vivo.
function logButton(action, interaction) {
  try {
    if (!interaction || !interaction.guild || (interaction.user && interaction.user.bot)) return;
    const key = String(action || "").toLowerCase();
    const label = BTN_LABEL[key] || `tocó el botón ${action}`;
    const ev = base(interaction);
    ev.message = label;
    ev.variables.cmd = "button:" + key;
    push(ev);
  } catch {}
}

module.exports = { logCommand, logButton };