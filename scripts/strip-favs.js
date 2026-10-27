/**
 * Limpia favoritos NO manuales en TODOS los servidores.
 * No necesita el bot parado ni loguearse a Discord.
 *
 * PowerShell:
 *   node scripts/strip-favs-all.js
 *
 * Opcional un solo guild:
 *   node scripts/strip-favs-all.js 311402172820619274
 */
const path = require("path");
const fs = require("fs");

process.chdir(path.join(__dirname, ".."));

try {
  require("dotenv").config();
} catch (_) {}

async function openMusic() {
  // 1) Misma vía que el bot: handlers/Database.js
  try {
    const fakeClient = {};
    const Database = require("../handlers/Database");
    if (typeof Database === "function") {
      await Database(fakeClient);
      if (fakeClient.music) {
        console.log("[strip] DB abierta vía handlers/Database.js");
        return fakeClient.music;
      }
    }
  } catch (e) {
    console.warn("[strip] Database.js no disponible:", e.message);
  }

  // 2) Fallback Josh directo (rutas habituales de este proyecto)
  const Josh = require("@joshdb/core");
  const provider = require("@joshdb/json");
  const candidates = [
    path.join(process.cwd(), "data", "music"),
    path.join(process.cwd(), "database", "music"),
    path.join(process.cwd(), "data"),
  ];
  for (const dataDir of candidates) {
    if (!fs.existsSync(dataDir)) continue;
    try {
      const music = new Josh({
        name: "music",
        provider,
        providerOptions: { dataDir },
      });
      // espera breve a que cargue
      await new Promise((r) => setTimeout(r, 300));
      console.log("[strip] DB abierta con Josh en", dataDir);
      return music;
    } catch (e) {
      console.warn("[strip] Josh falló en", dataDir, e.message);
    }
  }
  throw new Error("No se pudo abrir client.music / Josh. Revisa data/music");
}

async function guildIdsFromMusic(music) {
  const ids = new Set();
  // Si Josh tiene .all o .entries
  try {
    if (typeof music.all === "function") {
      const all = await music.all();
      if (all && typeof all === "object") {
        for (const key of Object.keys(all)) {
          const m = String(key).match(/^(\d{17,20})/);
          if (m) ids.add(m[1]);
        }
      }
    }
  } catch (_) {}

  // Algunas versiones: music.keys() / music.entries
  try {
    if (typeof music.keys === "function") {
      const keys = await music.keys();
      for (const key of keys || []) {
        const m = String(key).match(/^(\d{17,20})/);
        if (m) ids.add(m[1]);
      }
    }
  } catch (_) {}

  // Fallback: leer index.json de Josh
  for (const p of [
    path.join(process.cwd(), "data", "music", "index.json"),
    path.join(process.cwd(), "database", "music", "index.json"),
  ]) {
    try {
      if (!fs.existsSync(p)) continue;
      const idx = JSON.parse(fs.readFileSync(p, "utf8"));
      const keys = Array.isArray(idx) ? idx : Object.keys(idx || {});
      for (const key of keys) {
        const m = String(key).match(/^(\d{17,20})/);
        if (m) ids.add(m[1]);
      }
    } catch (_) {}
  }
  return [...ids];
}

async function main() {
  const onlyGuild = process.argv[2] || null;
  const music = await openMusic();
  const client = { music };

  const Store = require("../handlers/PlaylistStore");
  if (typeof Store.stripNonManualFavorites !== "function") {
    console.error(
      "Falta Store.stripNonManualFavorites en PlaylistStore.js. Pégalo antes de correr esto."
    );
    process.exit(1);
  }

  let guildIds = onlyGuild ? [onlyGuild] : await guildIdsFromMusic(music);
  if (!guildIds.length) {
    console.error("No se encontraron guildIds en la DB. Pasa uno: node scripts/strip-favs-all.js GUILD_ID");
    process.exit(1);
  }

  console.log(`[strip] Servidores a limpiar: ${guildIds.length}`);
  for (const guildId of guildIds) {
    try {
      const r = await Store.stripNonManualFavorites(client, guildId);
      const removed = (r.users || []).reduce((a, u) => a + (u.removed || 0), 0);
      const kept = (r.users || []).reduce((a, u) => a + (u.kept || 0), 0);
      console.log(`[strip] G:${guildId} removed=${removed} kept_manual=${kept}`);
    } catch (e) {
      console.error(`[strip] G:${guildId} ERROR:`, e.message || e);
    }
  }
  console.log("[strip] Listo.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});