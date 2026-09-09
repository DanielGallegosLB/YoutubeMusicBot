const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "yt-cookies.txt");
const YTDLP_PATH = path.join(
  ROOT,
  "node_modules/@distube/yt-dlp/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

function browserProfiles() {
  const local = process.env.LOCALAPPDATA || "";
  const appdata = process.env.APPDATA || "";
  const profiles = {
    edge: path.join(local, "Microsoft", "Edge", "User Data"),
    chrome: path.join(local, "Google", "Chrome", "User Data"),
    brave: path.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
    vivaldi: path.join(local, "Vivaldi", "User Data"),
    opera: path.join(appdata, "Opera Software", "Opera Stable"),
    firefox: path.join(appdata, "Mozilla", "Firefox"),
  };
  return Object.entries(profiles).filter(([, p]) => fs.existsSync(p));
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: String(err) });
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    setTimeout(() => proc.kill(), timeoutMs || 120000);
  });
}

async function validate() {
  if (!fs.existsSync(OUT) || fs.statSync(OUT).size < 50) return false;
  const res = await run(YTDLP_PATH, [
    "--cookies", OUT,
    "--js-runtimes", "node",
    "--no-warnings",
    "--no-download",
    "--skip-download",
    "--print", "%(title)s",
    "--playlist-items", "1-1",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  ], 120000);
  return (
    res.ok &&
    res.stdout.trim().length > 0 &&
    !/\bERROR\b/.test(res.stdout + res.stderr)
  );
}

async function main() {
  const browsers = browserProfiles();
  console.log(`Buscando navegadores en este equipo: ${browsers.length ? browsers.map(([n]) => n).join(", ") : "ninguno"}`);
  if (!fs.existsSync(YTDLP_PATH)) {
    console.error("No se encontró el binario de yt-dlp. Ejecuta `npm install` primero.");
    process.exit(1);
  }

  for (const [name, profile] of browsers) {
    if (browsers.length > 1) console.log(`\nProbando ${name}...`);
    const res = await run(YTDLP_PATH, [
      "--cookies-from-browser", name,
      "--cookies", OUT,
      "--no-warnings",
      "--skip-download",
      "--no-download",
      "--playlist-items", "1-1",
      "https://www.youtube.com",
    ], 180000);

    if (/DPAPI|failed to decrypt|App-Bound|app bound|OSError/i.test(res.stderr)) {
      console.log(`  ✗ ${name}: no se pudieron descifrar las cookies (Chrome/Edge v127+ cifran las cookies).`);
      continue;
    }
    if (!res.ok) {
      console.log(`  ✗ ${name}: error al exportar.`);
      continue;
    }
    console.log(`  ✓ Cookies exportadas de ${name}.`);
    if (await validate()) {
      console.log(`  ✓ Validado: yt-cookies.txt funciona correctamente.`);
      console.log(`\nListo. El bot ya usará estas cookies. (Reinicia el bot si estaba corriendo).`);
      process.exit(0);
    } else {
      console.log(`  ✗ Las cookies exportadas no sirven (sesión no autenticada o vencida).`);
      continue;
    }
  }

  console.log(`
No se pudo generar yt-cookies.txt automáticamente.

Exporta las cookies A MANO (requerido si usas Chrome/Edge reciente):

1. Abre una ventana de INCÓGNITO de Chrome/Edge y entra a YouTube con la cuenta
   que SÍ pueda ver videos con restricción de edad.
2. En ESA misma pestaña abre https://www.youtube.com/robots.txt
3. Exporta las cookies de "youtube.com" con una extensión tipo
   "Get cookies.txt LOCALLY" y guárdalas como yt-cookies.txt en la raíz del bot
   (SOBRESCRIBE el archivo existente).
4. Cierra la ventana de incógnito (Importante: nunca la vuelvas a abrir, así
   YouTube no rota las cookies).

Alternativa: pega la cadena de cookies en el .env como
YOUTUBE_COOKIE=... y ejecuta: node tools/convert-cookies.js

Reinicia el bot después de actualizar las cookies.
`);
  process.exit(1);
}

main();