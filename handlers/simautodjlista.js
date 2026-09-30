const fs = require("fs"), path = require("path"), os = require("os"), Module = require("module");
const SRC = "/home/claude/proj/src";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "autodjsrc-"));
const raw = fs.readFileSync(path.join(SRC, "data/music/josh_0.json"), "utf8").replace(/:\s*undefined\b/g, ":null");
const realDb = JSON.parse(raw);
const GID = "311402172820619274";
const autodjState = { picks: [] };
for (let i = 0; i < 24; i++) autodjState.picks.push({ url: `pick-url-${i}`, name: "pick-" + i });
const music = {
  async ensure() {},
  async get(k) {
    if (String(k) === `${GID}.autodj`) return autodjState;
    let c = realDb; for (const s of String(k).split(".")) { if (c == null) break; c = c[s]; } return c;
  },
  async set(k, v) { if (String(k) === `${GID}.autodj`) { Object.assign(autodjState, v); return; } },
};
const userNames = { "360609339725053952": "gerardogxo", "1139014720024760382": "userB", "1542393813421654086": "userC", "1038148003971739728": "dani_sas" };
const membersCache = new Map(Object.keys(userNames).map((id) => [id, { user: { tag: userNames[id] }, id }]));
membersCache.set("bot", { user: { tag: "JUGNU" }, id: "bot" });
const guild = { id: GID, members: { cache: membersCache, me: membersCache.get("bot") } };
const vc = { guild, members: { filter: () => [...membersCache.values()], size: 4 } };
const stubs = new Map([
  ["discord.js", { EmbedBuilder: class {}, Events: {}, Client: class {}, ButtonStyle: {}, Colors: {} }],
  ["./Client", class MusicBot {}], ["./AutoresumeHandler", async () => {}], ["./InitAutoResume", async () => {}], ["./InitAutoresume", async () => {}],
  ["./UserHistory", { recordPlaylistPlay: async () => {}, recordSongPlay: async () => {} }],
  ["./MusicTracker", { connect: () => {} }],
  ["./PlaybackError", { isAgeGateError: () => false, friendlyPlaybackError: () => "x" }],
  ["./ActivityManager", { startMarqueeActivity: () => null, stopMarqueeActivity: () => null }],
  ["../settings/config", { embed: { color: 0 }, emoji: {}, options: { defaultVolume: 100, leaveTimeout: 5000 }, filters: {}, slash: {} }],
  ["../index", {}],
]);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request && stubs.has(request)) return stubs.get(request);
  if (parent && parent.filename && parent.filename.startsWith(TMP) && request.startsWith("./"))
    return origLoad.call(Module, require.resolve(path.join(SRC, "handlers", request)), parent, isMain);
  return origLoad.apply(this, arguments);
};
const eventsTmp = path.join(TMP, "DistubeEvents.js");
fs.writeFileSync(eventsTmp, fs.readFileSync(path.join(SRC, "handlers/DistubeEvents.js"), "utf8"));
const AutoDjSource = require(path.join(SRC, "handlers/AutoDjSource.js"));

const bot = membersCache.get("bot"), dani = membersCache.get("1038148003971739728");
const mk = (url, extra = {}) => ({ url, name: url, formattedDuration: "03:00", user: dani.user, member: dani, ...extra });
const client = {
  music, config: { embed: { color: 0 } },
  logger: { log: () => {}, warn: () => {}, error: (...a) => console.log("[err]", ...a) },
  distube: {
    on: () => null,
    play: async (v, url) => { client._queue.songs.push(mk(url, { member: bot, user: bot.user })); return {}; },
    getQueue: () => client._queue, voices: { leave: async () => {} },
  },
  updatequeue: async () => null, updateplayer: async () => null,
  getTitle: (t) => t?.name || t, actualPlaying: new Map(), on: () => null,
  autoDj: new Map([[GID, true]]), playlistStopped: new Map(),
};
let fails = 0;
const check = (c, m) => { if (!c) { fails++; console.log("  ✗ FAIL:", m); } };
const dupsIn = (songs) => { const s = new Set(); let d = 0; for (const x of songs) { if (s.has(x.url)) d++; s.add(x.url); } return d; };
const LIST = Array.from({ length: 316 }, (_, i) => `list-${i}`);
function newSession(loaded) {
  AutoDjSource.reset(client, GID);
  AutoDjSource.register(client, GID, LIST);
  client._queue = { songs: [mk("list-0")], textChannel: { guildId: GID }, guildId: GID, voice: { connection: { channel: vc } } };
  for (let i = 1; i < loaded; i++) client._queue.songs.push(mk(LIST[i]));
  AutoDjSource.markUsed(client, GID, "list-0");
  autodjState.seen = [];
}
// Simula el loader real (con su regla de saltar las usadas) encolando lo que falta
function loaderFinish() {
  const q = client._queue; let skipped = 0;
  for (const u of LIST) {
    if (AutoDjSource.isUsed(client, GID, u)) { skipped++; continue; }
    if (q.songs.some((x) => x.url === u)) continue;
    q.songs.push(mk(u));
  }
  return skipped;
}
function consumeAndPlay(q) { const s = q.songs.shift(); return s; }
(async () => {
  const DistubeEvents = require(eventsTmp);
  await DistubeEvents(client);

  console.log("=== 1) AutoDJ activado con SOLO 5 de 316 cargadas: la 🎲 sale de toda la lista ===");
  newSession(5);
  const n1 = await client.autoDjRefill(client._queue, { channel: vc, force: true });
  const bots1 = client._queue.songs.filter((s) => s.autoDj);
  console.log(`  añadidas=${n1} · top: ${client._queue.songs.slice(0, 4).map((s) => (s.autoDjType || "man") + ":" + s.url).join(" | ")}`);
  check(n1 === 2, "debía añadir rec+random");
  check(bots1[0]?.autoDjType === "rec" && bots1[1]?.autoDjType === "random", "orden rec, random");
  check(bots1[1] && /^list-/.test(bots1[1].url), "la 🎲 debe venir de la lista de 316");

  console.log("\n=== 2) 60 canciones sonando con la lista cargándose en paralelo: 0 repetidas ===");
  newSession(5);
  const played = []; const randSrc = { loaded: 0, notLoaded: 0 };
  for (let step = 0; step < 60; step++) {
    const q = client._queue;
    await client.autoDjRefill(q, { channel: vc, force: step === 0 });
    const cur = q.songs[0];
    if (step > 0) { /* cur ya salió del top */ }
    check(dupsIn(q.songs) === 0, `duplicadas en cola en paso ${step}`);
    if (step === 25) { const sk = loaderFinish(); console.log(`  (loader termina en paso 25; saltó ${sk} ya usadas)`); check(dupsIn(client._queue.songs) === 0, "loader no debe duplicar"); }
    // suena el siguiente
    const next = q.songs[1]; if (!next) break;
    consumeAndPlay(q);
    AutoDjSource.markUsed(client, GID, q.songs[0].url); played.push(q.songs[0]);
    if (q.songs[0].autoDjType === "random") { randSrc.loaded++; }
  }
  const urls = played.map((s) => s.url);
  const dups = urls.length - new Set(urls).size;
  const types = played.map((s) => s.autoDjType || "man");
  const alt = types.slice(0, 20).join(",");
  { const c = {}; for (const x of played) c[x.url] = (c[x.url]||0)+1; const d = Object.entries(c).filter(([,n])=>n>1); if (d.length) console.log("  repetidas:", d.map(([u,n])=>`${u} x${n} (${played.find(x=>x.url===u).autoDjType||"man"})`).join("; ")); const recs = new Set(played.filter(x=>x.autoDjType==="rec").map(x=>x.url)); console.log(`  recs distintas=${recs.size} de ${played.filter(x=>x.autoDjType==="rec").length}`); }
  console.log(`  sonaron=${played.length} · repetidas=${dups} · primeras 20 tipos: ${alt}`);
  { const nonRec = played.filter((x) => x.autoDjType !== "rec").map((x) => x.url); check(nonRec.length === new Set(nonRec).size, "🎲/manuales no deben repetirse"); 
    const recU = played.filter((x) => x.autoDjType === "rec").map((x) => x.url); const firstRep = recU.findIndex((u, i) => recU.indexOf(u) !== i);
    check(firstRep === -1 || firstRep >= 30, `rec solo puede repetirse tras agotar su pool (30), repitió en la #${firstRep + 1}`); }
  const rnd = played.filter((s) => s.autoDjType === "random");
  check(rnd.length >= 20 && rnd.every((s) => /^list-/.test(s.url)), "las 🎲 salen de la lista");
  const rndIdx = rnd.map((s) => +s.url.split("-")[1]);
  console.log(`  🎲 (índices en la lista de 316): ${rndIdx.slice(0, 20).join(", ")}`);
  check(new Set(rndIdx).size === rndIdx.length, "🎲 sin repetir");
  check(Math.max(...rndIdx) > 100 && rndIdx.some((i) => i > 5), "🎲 abarca la lista, no solo el inicio");

  console.log("\n=== 3) Lista ya cargada completa (316 en cola): 🎲 MUEVE una de la cola, sin duplicar ===");
  newSession(316);
  const before = client._queue.songs.length;
  const n3 = await client.autoDjRefill(client._queue, { channel: vc, force: true });
  const q3 = client._queue;
  console.log(`  añadidas=${n3} · cola ${before} -> ${q3.songs.length} (igual: se movió, no se duplicó) · top: ${q3.songs.slice(0, 3).map((s) => s.url).join(" | ")}`);
  check(q3.songs.length === before + 1, "rec agrega 1 (favorita nueva) y la 🎲 solo se mueve");
  check(dupsIn(q3.songs) === 0, "sin duplicadas");
  check(q3.songs[2]?.autoDjType === "random", "la 🎲 quedó intercalada tras la rec");

  console.log("\n=== 4) Regresión: cola corta (2) se rellena; ciclo completo no agrega ===");
  newSession(3);
  const n4 = await client.autoDjRefill(client._queue, { channel: vc, force: false });
  check(n4 >= 1, "cola corta debe rellenar");
  newSession(60);
  await client.autoDjRefill(client._queue, { channel: vc, force: true });
  const n4b = await client.autoDjRefill(client._queue, { channel: vc, force: false });
  check(n4b === 0, "con el ciclo completo delante no agrega");

  console.log(fails ? `\n❌ ${fails} FALLAS` : "\n✅ TODO OK");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SIM ERROR", e); process.exit(1); });