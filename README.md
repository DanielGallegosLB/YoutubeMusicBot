<div align="center">

# DISCORD MUSIC — Discord Music Bot 🎵

[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-43853D?logo=node.js&style=flat-square)](https://nodejs.org/)

High‑quality Discord music bot powered by DisTube and discord.js v14 — YouTube, Spotify, SoundCloud, filters, autoplay, 24/7, request channel, lyrics, and more.

</div>

## Features

- YouTube, Spotify, and SoundCloud playback
- Slash commands and message commands
- 24/7 voice channel + autoresume
- Rich queue controls: skip, seek, loop, shuffle, move, remove, jump, filters
- Lyrics lookup, request channel system, DJ role
- Works on Replit/VPS, uses DisTube + discord.js v14

---

## Installation

1) Install latest LTS [Node.js](https://nodejs.org/) (>= 18.17) and [Python](https://www.python.org/downloads/).

2) Clone or download the repository.

3) Install dependencies:

```powershell
npm install
```

4) Configure the bot in `settings/config.js` and `.env`.

### _Modify - config.js_

```javascript
{
  TOKEN: "BOT_TOKEN",
  PREFIX: "BOT_PREFIX",
  mongodb : "MONGO_URL"
}
```

### _Modify - .env_

Rename `.env.example` to `.env` and configure the following keys:

```env
# Discord
TOKEN=
PREFIX=

# Database (optional if using JSON storage)
MONGO_URL=

# Slash commands
# Comma-separated list of guild IDs (for faster, per-guild registration)
GUILD_ID=
# Set to true to register commands globally (may take up to 1 hour to propagate)
SLASH_GLOBAL=false

# Web server
PORT=3000

# Reduce noisy update checks from ytsr/ytdl
YTSR_NO_UPDATE=true
YTDL_NO_UPDATE=true

# Voice diagnostics (optional; set true to print a dependency report on startup)
VOICE_DEBUG_REPORT=false
```

Notes:
- If you want global slash commands, set `SLASH_GLOBAL=true`. Otherwise, keep `GUILD_ID` set (you can provide multiple IDs separated by commas) for instant per‑guild updates.
- `MONGO_URL` enables MongoDB storage via JoshDB’s Mongo provider; if omitted, JSON storage is used.

5) Optional native optimizations (Windows/macOS/Linux):

```powershell
npm install @discordjs/opus zlib-sync@latest erlpack@latest
```

6) Start the bot:

```powershell
npm start
```

Dev mode with auto-reload:

```powershell
npm run dev
```

## Security

Please report vulnerabilities privately.

## License

This project is licensed under the [MIT License](LICENSE).
