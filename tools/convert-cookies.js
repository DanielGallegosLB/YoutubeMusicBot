const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const outputPath = path.join(__dirname, '..', 'yt-cookies.txt');

const envContent = fs.readFileSync(envPath, 'utf-8');
const cookieLine = envContent.split('\n').find(l => l.startsWith('YOUTUBE_COOKIE='));

if (!cookieLine) {
  console.error('YOUTUBE_COOKIE not found in .env');
  process.exit(1);
}

const raw = cookieLine.split('=').slice(1).join('=').replace(/^"|"$/g, '');
const pairs = raw.split(';').map(p => p.trim()).filter(Boolean);

const lines = ['# Netscape HTTP Cookie File'];
const expiry = 1893456000;

for (const pair of pairs) {
  const idx = pair.indexOf('=');
  if (idx === -1) continue;
  const name = pair.slice(0, idx).trim();
  const value = pair.slice(idx + 1).trim();
  lines.push(`.youtube.com\tTRUE\t/\tTRUE\t${expiry}\t${name}\t${value}`);
}

fs.writeFileSync(outputPath, lines.join('\n') + '\n');
console.log(`Wrote ${pairs.length} cookies to ${outputPath}`);
