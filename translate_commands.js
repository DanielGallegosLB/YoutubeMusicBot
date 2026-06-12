const fs = require('fs');
const path = require('path');

const translations = {
  "ayuda": { en: "help", desc: "Need help? View all my commands" },
  "estadisticas": { en: "stats", desc: "View bot statistics" },
  "invitar": { en: "invite", desc: "Get the bot's invitation link" },
  "latencia": { en: "ping", desc: "View the bot's latency" },
  "tiempoactivo": { en: "uptime", desc: "View how long the bot has been active" },
  "aleatorio": { en: "shuffle", desc: "Enable shuffle mode for the queue" },
  "autoreproducir": { en: "autoplay", desc: "Toggle autoplay on or off" },
  "avanzara": { en: "forward", desc: "Forward the current song" },
  "buscar": { en: "search", desc: "Search for a song" },
  "buscarlista": { en: "searchplaylist", desc: "Search for a playlist" },
  "continuar": { en: "resume", desc: "Resume paused music" },
  "deshaceraleatorio": { en: "unshuffle", desc: "Disable shuffle mode" },
  "detener": { en: "stop", desc: "Stop the music and clear the queue" },
  "filtro": { en: "filter", desc: "Apply a filter to the music" },
  "letra": { en: "lyrics", desc: "Search for song lyrics" },
  "limpiarlista": { en: "clearqueue", desc: "Clear the playback queue" },
  "lista": { en: "queue", desc: "View the current playback queue" },
  "mover": { en: "move", desc: "Move a song's position in the queue" },
  "pausar": { en: "pause", desc: "Pause the current music" },
  "quitar": { en: "remove", desc: "Remove a song from the queue" },
  "quitarrepetidos": { en: "removedupes", desc: "Remove duplicate songs from the queue" },
  "reordenar": { en: "reorder", desc: "Reorder the playback queue" },
  "repetir": { en: "loop", desc: "Change the repeat mode" },
  "reproducir": { en: "play", desc: "Play a song or playlist" },
  "reproduciranterior": { en: "previous", desc: "Play the previous song" },
  "reproducirprimero": { en: "playfirst", desc: "Play a song at the beginning of the queue" },
  "saltar": { en: "skip", desc: "Skip to the next song" },
  "saltara": { en: "skipto", desc: "Skip to a specific song in the queue" },
  "saltaryreproducir": { en: "skipandplay", desc: "Skip current song and play a new one" },
  "sonandoahora": { en: "nowplaying", desc: "View what song is currently playing" },
  "volumen": { en: "volume", desc: "Change the music volume" },
  "volverareproducir": { en: "replay", desc: "Replay the current song" },
  "borrarlista": { en: "deleteplaylist", desc: "Delete a saved playlist" },
  "crearlista": { en: "createplaylist", desc: "Create a new playlist" },
  "detalleslista": { en: "playlistdetails", desc: "View playlist details" },
  "exportarlista": { en: "exportplaylist", desc: "Export a playlist" },
  "guardarcancionenlista": { en: "addtoplaylist", desc: "Save a song to a playlist" },
  "guardarlistaactual": { en: "savequeue", desc: "Save the current queue" },
  "importarlista": { en: "importplaylist", desc: "Import a playlist" },
  "mislistas": { en: "myplaylists", desc: "View your playlists" },
  "quitarcancionlista": { en: "removefromplaylist", desc: "Remove a song from a playlist" },
  "renombrarlista": { en: "renameplaylist", desc: "Rename a playlist" },
  "reproducirlista": { en: "playplaylist", desc: "Play a saved playlist" },
  "autoresumen": { en: "autoresume", desc: "Toggle autoresume on or off" },
  "calidadalta": { en: "highquality", desc: "Toggle high quality on or off" },
  "configuracion": { en: "settings", desc: "View bot settings" },
  "configurarmusica": { en: "musicsetup", desc: "Set up the music channel" },
  "dj": { en: "dj", desc: "Configure the DJ role" },
  "prefijo": { en: "prefix", desc: "Change the bot prefix" },
  "reiniciar": { en: "restart", desc: "Restart the bot" },
  "siempreactivo": { en: "247", desc: "Toggle 24/7 mode on or off" },
  "añadiracola": { en: "addtoqueue", desc: "Add a song to the queue" },
  "resumir": { en: "summary", desc: "Resume one of the last saved music sessions" }
};

const optionTranslations = {
  "cancion": { en: "song", desc: "The name or link of the song/playlist" },
  "filtro": { en: "filter", desc: "The filter to apply" },
  "index": { en: "index", desc: "The index of the song" },
  "nueva_posicion": { en: "new_position", desc: "The new position of the song" },
  "posicion": { en: "position", desc: "The position of the song" },
  "volumen": { en: "volume", desc: "The volume percentage" },
  "modo": { en: "mode", desc: "The repeat mode" },
  "nombre": { en: "name", desc: "The name of the playlist" },
  "lista": { en: "playlist", desc: "The name of the playlist" },
  "id": { en: "id", desc: "The ID of the playlist" },
  "servidor": { en: "server", desc: "The server ID" },
  "rol": { en: "role", desc: "The DJ role" },
  "canal": { en: "channel", desc: "The music channel" }
};

function getAllFiles(dirPath, arrayOfFiles) {
  files = fs.readdirSync(dirPath);

  arrayOfFiles = arrayOfFiles || [];

  files.forEach(function(file) {
    if (fs.statSync(dirPath + "/" + file).isDirectory()) {
      arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
    } else {
      arrayOfFiles.push(path.join(dirPath, "/", file));
    }
  });

  return arrayOfFiles;
}

// Update Message Commands
const messageFiles = getAllFiles('Commands/Message');
messageFiles.forEach(file => {
  if (!file.endsWith('.js')) return;
  let content = fs.readFileSync(file, 'utf8');
  
  // Find the name property
  const nameMatch = content.match(/name:\s*["']([^"']+)["']/);
  if (nameMatch) {
    const name = nameMatch[1];
    const trans = translations[name];
    if (trans) {
      // Find aliases
      const aliasesMatch = content.match(/aliases:\s*\[([^\]]*)\]/);
      if (aliasesMatch) {
        const aliases = aliasesMatch[1].split(',').map(a => a.trim().replace(/["']/g, '')).filter(Boolean);
        if (!aliases.includes(trans.en)) {
          aliases.push(trans.en);
          const newAliasesStr = `aliases: [${aliases.map(a => `"${a}"`).join(", ")}]`;
          content = content.replace(/aliases:\s*\[[^\]]*\]/, newAliasesStr);
        }
      } else {
        // Add aliases if not present
        content = content.replace(/(name:\s*["'][^"']+["'],)/, `$1\n  aliases: ["${trans.en}"],`);
      }
      fs.writeFileSync(file, content);
    }
  }
});

// Update Slash Commands
const slashFiles = getAllFiles('Commands/Slash');
slashFiles.forEach(file => {
  if (!file.endsWith('.js')) return;
  let content = fs.readFileSync(file, 'utf8');

  // Update command name and description localizations
  const nameMatch = content.match(/name:\s*["']([^"']+)["']/);
  if (nameMatch) {
    const name = nameMatch[1];
    const trans = translations[name];
    if (trans) {
      if (!content.includes('name_localizations')) {
        content = content.replace(/(name:\s*["'][^"']+["'],)/, `$1\n  name_localizations: {\n    "en-US": "${trans.en}",\n    "en-GB": "${trans.en}",\n  },`);
      }
      if (!content.includes('description_localizations')) {
        content = content.replace(/(description:\s*`[^`]+`,)/, `$1\n  description_localizations: {\n    "en-US": "${trans.desc}",\n    "en-GB": "${trans.desc}",\n  },`);
        content = content.replace(/(description:\s*"[^"]+",)/, `$1\n  description_localizations: {\n    "en-US": "${trans.desc}",\n    "en-GB": "${trans.desc}",\n  },`);
      }
    }
  }

  // Update options localizations
  // This is a bit more complex. I'll use a regex for option blocks.
  const optionRegex = /{\s*name:\s*["']([^"']+)["'],\s*description:\s*[`"']([^`"']+)[`"'],/g;
  content = content.replace(optionRegex, (match, optName, optDesc) => {
    const trans = optionTranslations[optName];
    if (trans && !match.includes('name_localizations')) {
      return `{\n      name: "${optName}",\n      name_localizations: {\n        "en-US": "${trans.en}",\n        "en-GB": "${trans.en}",\n      },\n      description: "${optDesc}",\n      description_localizations: {\n        "en-US": "${trans.desc}",\n        "en-GB": "${trans.desc}",\n      },`;
    }
    return match;
  });

  fs.writeFileSync(file, content);
});

console.log('Localization completed.');
