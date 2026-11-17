/**
 * Almacén en MEMORIA con escritura diferida a data/<nombre>/josh_0.json.
 *
 * Reemplaza a @joshdb/json (que reescribía el archivo entero, ~700 KB, en CADA set
 * y provocaba EPERM en Windows). Todo vive en RAM; el disco se actualiza agrupando
 * ráfagas (debounce) y de forma atómica (tmp + rename).
 *
 * API compatible con lo que usa el bot de Josh:
 *   get(path) · set(path, v) · delete(path) · has(path) · ensure(path, def) · keys (getter async)
 * Extras: flush() · flushSync() · writeStats()
 *
 * Formato en disco: igual que @joshdb/json → { "<clave>": <documento>, ... } + index.json.
 * Lee también archivos "sueltos" (con `undefined`) que dejó el proveedor anterior.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const split = (p) => String(p).split(".");
const isObj = (v) => v !== null && typeof v === "object";

/** Parser tolerante (acepta `undefined`) sin acceso a process/require y con tope de tiempo. */
function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    /* sigue */
  }
  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const val = vm.runInContext("(" + text + "\n)", ctx, { timeout: 5000 });
  // Normaliza a JSON estricto: quita undefined / funciones.
  return JSON.parse(JSON.stringify(val));
}

class MemoryStore {
  constructor(opts = {}) {
    this.name = opts.name || "store";
    this.dir = path.resolve(opts.dir || path.join(__dirname, "..", "data", this.name));
    this.file = path.join(this.dir, "josh_0.json");
    this.debounceMs = opts.debounceMs ?? 2000;
    this.maxDelayMs = opts.maxDelayMs ?? 10000;
    this.log = opts.log || ((m) => console.warn(m));
    this.data = Object.create(null);
    this._dirty = false;
    this._dirtySince = 0;
    this._timer = null;
    this._running = null;
    this._st = { writes: 0, failed: 0, coalesced: 0, maxPending: 0, runningSince: 0, lastWriteMs: 0, lastBytes: 0 };
    this._load();
  }

  // ───────────────────────── carga ─────────────────────────
  _load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      this.log(`[MemoryStore:${this.name}] no se pudo crear ${this.dir}: ${e.message}`);
    }
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (_) {
      return; // no existe aún → vacío
    }
    if (!text.trim()) return;
    try {
      const obj = parseLoose(text);
      if (!isObj(obj) || Array.isArray(obj)) throw new Error("la raíz no es un objeto");
      for (const [k, v] of Object.entries(obj)) this.data[k] = v;
    } catch (e) {
      this.log(`no se pudo leer josh_0.json (${this.name}): ${e.message}`);
      try {
        fs.copyFileSync(this.file, path.join(this.dir, `josh_0.corrupt-${Date.now()}.json`));
      } catch (_) {}
      this.data = Object.create(null);
    }
  }

  // ───────────────────────── lectura ─────────────────────────
  _read(p) {
    let cur = this.data;
    for (const part of split(p)) {
      if (!isObj(cur) || !(part in cur)) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  get keys() {
    return Promise.resolve(Object.keys(this.data));
  }

  async get(p) {
    return clone(this._read(p));
  }

  async has(p) {
    return this._read(p) !== undefined;
  }

  // ───────────────────────── escritura ─────────────────────────
  async set(p, value) {
    const parts = split(p);
    const v = clone(value);
    if (parts.length === 1) {
      this.data[parts[0]] = v;
    } else {
      let cur = this.data;
      for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (!isObj(cur[k])) cur[k] = {};
        cur = cur[k];
      }
      cur[parts[parts.length - 1]] = v;
    }
    this._markDirty();
    return this;
  }

  async delete(p) {
    const parts = split(p);
    let cur = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isObj(cur[parts[i]])) return this;
      cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (isObj(cur) && last in cur) {
      if (Array.isArray(cur)) cur.splice(Number(last), 1);
      else delete cur[last];
      this._markDirty();
    }
    return this;
  }

  async ensure(p, def) {
    const cur = this._read(p);
    if (cur !== undefined) return clone(cur);
    await this.set(p, def);
    return clone(def);
  }

  // ───────────────────────── escritura a disco ─────────────────────────
  _markDirty() {
    if (this._dirty) this._st.coalesced++;
    else {
      this._dirty = true;
      this._dirtySince = Date.now();
    }
    this._st.maxPending = Math.max(this._st.maxPending, 1);
    this._schedule();
  }

  _schedule() {
    if (this._timer) clearTimeout(this._timer);
    const waited = Date.now() - this._dirtySince;
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxDelayMs - waited));
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => {});
    }, wait);
    this._timer.unref?.();
  }

  _serialize() {
    return JSON.stringify(this.data);
  }

  _indexText() {
    return JSON.stringify({ files: [{ keys: Object.keys(this.data), location: this.file }] });
  }

  async _writeOnce() {
    const t0 = Date.now();
    const text = this._serialize();
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(tmp, text, "utf8");
    try {
      await fs.promises.rename(tmp, this.file);
    } catch (e) {
      // Windows (antivirus/OneDrive): EPERM/EBUSY → escritura directa y limpieza.
      await fs.promises.writeFile(this.file, text, "utf8");
      await fs.promises.unlink(tmp).catch(() => {});
    }
    await fs.promises.writeFile(path.join(this.dir, "index.json"), this._indexText(), "utf8").catch(() => {});
    this._st.writes++;
    this._st.lastBytes = Buffer.byteLength(text);
    this._st.lastWriteMs = Date.now() - t0;
  }

  /** Guarda lo pendiente ahora. Resuelve cuando no queda nada sucio. */
  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._running) {
      await this._running.catch(() => {});
    }
    while (this._dirty) {
      this._dirty = false; // lo que se mute durante la escritura vuelve a marcar sucio
      this._st.runningSince = Date.now();
      this._running = this._writeOnce();
      try {
        await this._running;
      } catch (e) {
        this._st.failed++;
        this._dirty = true;
        this._dirtySince = Date.now();
        this.log(`[MemoryStore:${this.name}] error guardando: ${e.message} (se reintenta)`);
        this._running = null;
        this._st.runningSince = 0;
        this._schedule();
        return;
      }
      this._running = null;
      this._st.runningSince = 0;
    }
  }

  /** Guardado síncrono para la salida del proceso. */
  flushSync() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      const text = this._serialize();
      fs.writeFileSync(tmp, text, "utf8");
      try {
        fs.renameSync(tmp, this.file);
      } catch (_) {
        fs.writeFileSync(this.file, text, "utf8");
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
      try { fs.writeFileSync(path.join(this.dir, "index.json"), this._indexText(), "utf8"); } catch (_) {}
      this._dirty = false;
      this._st.writes++;
    } catch (e) {
      this._st.failed++;
    }
  }

  writeStats() {
    const s = this._st;
    return {
      name: this.name,
      pending: this._dirty ? 1 : 0,
      maxPending: s.maxPending,
      coalesced: s.coalesced,
      writes: s.writes,
      failed: s.failed,
      runningSince: s.runningSince,
      stuckMs: s.runningSince ? Date.now() - s.runningSince : 0,
      lastWriteMs: s.lastWriteMs,
      lastBytes: s.lastBytes,
    };
  }
}

// ───────────────────────── vaciado al salir ─────────────────────────
const _stores = new Set();
let _hooked = false;

function flushAllSync() {
  for (const s of _stores) {
    try { s.flushSync(); } catch (_) {}
  }
}

function installExitHooks() {
  if (_hooked) return;
  _hooked = true;
  // 'exit' cubre process.exit(75) de MemoryGuard y salidas normales: solo código síncrono.
  process.on("exit", flushAllSync);
  const codes = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGBREAK: 21 };
  for (const sig of Object.keys(codes)) {
    try {
      process.on(sig, () => {
        flushAllSync();
        // Si nadie más maneja la señal, se sale con el código convencional.
        if (process.listenerCount(sig) <= 1) process.exit(128 + codes[sig]);
      });
    } catch (_) {
      /* SIGBREAK no existe fuera de Windows */
    }
  }
  // NO se engancha uncaughtException: index.js ya lo maneja para mantener el bot vivo,
  // y si el proceso muere igual, 'exit' vacía el estado.
}

/** Crea un store y lo registra para el vaciado al salir. */
function createStore(opts) {
  const s = new MemoryStore(opts);
  _stores.add(s);
  installExitHooks();
  return s;
}

module.exports = { MemoryStore, createStore, parseLoose, flushAllSync };
