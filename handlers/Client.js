const {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
  User,
  EmbedBuilder,
} = require("discord.js");
const fs = require("fs");
const Distube = require("distube").default;
const { Song } = require("distube");
const { SpotifyPlugin } = require("@distube/spotify");
const { YouTubePlugin } = require("@distube/youtube");
const { filters, options } = require("../settings/config");
const { YtDlpPlugin, json: ytDlpJson } = require("@distube/yt-dlp");
const Logger = require("./Logger");
const resolveSpotifyFallback = require("./spotify-fallback");

class MusicBot extends Client {
  constructor() {
    super({
      partials: [
        Partials.Channel,
        Partials.GuildMember,
        Partials.Message,
        Partials.User,
      ],
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      shards: "auto",
      failIfNotExists: false,
      allowedMentions: {
        parse: ["everyone", "roles", "users"],
        users: [],
        roles: [],
        repliedUser: false,
      },
    });

    this.events = new Collection();
    this.cooldowns = new Collection();
    this.mcommands = new Collection();
    this.commands = new Collection();
    this.aliases = new Collection();
    this.shuffleData = new Collection();
    this.leaveTimeoutHandles = new Collection();
    this.playlistLoading = new Collection();
    this.playlistStopped = new Collection();
    this.likeClaims = new Map();
    this.skipLocks = new Map();
    this.autoDj = new Map();
    this.autoDjPrev = new Map();
    this.autoDjIntent = new Map();
    this.autoDjBusy = new Map();
    this.ffmpegRetry = new Map();
    this.mcategories = fs.readdirSync("./Commands/Message");
    this.scategories = fs.readdirSync("./Commands/Slash");
    this.temp = new Collection();
    this.previewMessages = new Collection();
    this.config = require("../settings/config");
    this.logger = Logger;

    const ytDlpPlugin = new YtDlpPlugin({
      update: false,
      ytdlpOptions: (() => {
        const opts = {
          socketTimeout: 60,
          fragmentRetries: 10,
          addHeader: [
            "referer:https://www.youtube.com",
          ],
          jsRuntimes: "node",
          noCheckCertificates: true,
          format: "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
          extractorArgs: "youtube:player_client=web_embedded,android",
        };
        try {
          const pathMod = require("path");
          const fsMod = require("fs");
          for (const rel of ["../yt-cookies.txt", "../yt-cookies.txt.bak"]) {
            const cookiePath = pathMod.join(__dirname, rel);
            if (fsMod.existsSync(cookiePath) && fsMod.statSync(cookiePath).size > 10) {
              opts.cookies = cookiePath;
              break;
            }
          }
        } catch (_) {}
        return opts;
      })(),
    });

    this.searcher = new YouTubePlugin();
    this.searcher.getStreamURL = (song) => ytDlpPlugin.getStreamURL(song);
    this.searcher.validate = () => false;

    // ── Cache + warm-up de URL de stream ────────────────────────────────
    // getStreamURL de YtDlpPlugin corre un yt-dlp COMPLETO (simulate + format)
    // CADA vez que arranca una canción. Sin caché, cada skip = 5-15s de
    // extracción. Aquí se memoriza por URL y además se pre-resuelven las
    // siguientes canciones de la cola (warmStreamURLs) para que el skip sea
    // instantáneo: Distube salta la extracción si song.stream.url ya está seteada.
    const STREAM_URL_TTL_MS = Math.max(60000, Number(process.env.STREAM_URL_TTL_MS) || 30 * 60 * 1000);
    this._streamURLCache = new Map();
    const rawGetStreamURL = ytDlpPlugin.getStreamURL.bind(ytDlpPlugin);
    const cacheGetStreamURL = async (song) => {
      const key = song?.url;
      if (!key) return rawGetStreamURL(song);
      const hit = this._streamURLCache.get(key);
      if (hit && Date.now() - hit.at < STREAM_URL_TTL_MS) return hit.url;
      const url = await rawGetStreamURL(song);
      if (url) this._streamURLCache.set(key, { url, at: Date.now() });
      return url;
    };
    ytDlpPlugin.getStreamURL = cacheGetStreamURL;
    const originalSearchSong = this.searcher.searchSong.bind(this.searcher);
    this.searcher.searchSong = async (query, options = {}) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await originalSearchSong(query, options);
          if (result) return result;
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
      try {
        const info = await ytDlpJson(`ytsearch1:${query}`, ytDlpPlugin.ytdlpOptions, {});
        const entry = info && info.entries ? info.entries[0] : info;
        if (!entry || !entry.id) return null;
        return new Song(
          {
            plugin: this.searcher,
            source: "youtube",
            playFromSource: true,
            id: entry.id,
            name: entry.title,
            url: entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`,
            thumbnail: entry.thumbnail,
            duration: entry.duration,
            uploader: { name: entry.channel || entry.uploader || "" },
          },
          options
        );
      } catch (error) {
        this.logger.error(`[YTSEARCH_FALLBACK] Búsqueda con yt-dlp falló para "${query}": ${error.message || error}`);
        throw error;
      }
    };

    const spotifyPlugin = new SpotifyPlugin({
      api: {
        clientId: this.config.SPOTIFY_CLIENT_ID,
        clientSecret: this.config.SPOTIFY_CLIENT_SECRET,
      },
    });
    const originalSpotifyResolve = spotifyPlugin.resolve.bind(spotifyPlugin);
    spotifyPlugin.resolve = async (url, options = {}) => {
      try {
        return await originalSpotifyResolve(url, options);
      } catch (error) {
        try {
          const fallback = await resolveSpotifyFallback(spotifyPlugin, url, options);
          if (fallback) {
            this.logger.warn(
              `[SPOTIFY_FALLBACK] Scraping oficial de Spotify falló (${error.message || error}); se usó el parser embebido.`
            );
            return fallback;
          }
        } catch (_) {}
        throw error;
      }
    };

    this.distube = new Distube(this, {
      emitNewSongOnly: true,
      nsfw: false,
      savePreviousSongs: true,
      joinNewVoiceChannel: false,
      customFilters: filters,
      plugins: [
        spotifyPlugin,
        this.searcher,
        ytDlpPlugin,
      ],
      ffmpeg: {
        path: (() => {
          if (process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim()) {
            return process.env.FFMPEG_PATH;
          }
          try {
            return require("ffmpeg-static");
          } catch (_) {
            try {
              const inst = require("@ffmpeg-installer/ffmpeg");
              return inst && inst.path ? inst.path : undefined;
            } catch (_) {
              return undefined;
            }
          }
        })(),
      },
    });

    // Pre-resuelve (en segundo plano) las URLs de stream de las PRÓXIMAS `count`
    // canciones de la cola y las deja en song.stream.url. Distube entonces salta
    // la extracción de yt-dlp al reproducirlas: el skip/transición es inmediato.
    // 1 sola a la vez para no competir con la reproducción ni saturar la red.
    this._warmInFlight = this._warmInFlight || new Set();
    this.warmStreamURLs = (queue, count = 2) => {
      try {
        if (!queue?.songs?.length) return;
        const targets = queue.songs
          .slice(1, 1 + Math.max(0, count))
          .filter((s) => s?.url && s.stream?.playFromSource && !s.stream.url);
        if (!targets.length) return;
        (async () => {
          for (const song of targets) {
            if (this._warmInFlight.has(song.url)) continue;
            this._warmInFlight.add(song.url);
            try {
              const url = await cacheGetStreamURL(song);
              if (url && song.stream && !song.stream.url) song.stream.url = url;
            } catch (_) {
            } finally {
              this._warmInFlight.delete(song.url);
            }
          }
        })();
      } catch (_) {}
    };
  }

  start(token) {
    [
      "handler",
      "Database",
      "DistubeEvents",
      "RequestChannel",
      "ChannelCleaner",
      "DistubeHandler",
      "QueueBridge",
      "utils",
    ].forEach((handler) => {
      require(`./${handler}`)(this);
    });
    this.login(token);
  }

  /**
   * @param {User} user
   */
  getFooter(user) {
    const obj = {
      text: `Requested By ${user.username}`,
      iconURL: user.displayAvatarURL(),
    };
    return options.embedFooter ? obj : null;
  }

  embed(interaction, data) {
    let user = interaction.user ? interaction.user : interaction.author;
    if (interaction.deferred || interaction.replied) {
      interaction
        .followUp({
          embeds: [
            new EmbedBuilder()
              .setColor(this.config.embed.color)
              .setDescription(`${data.substring(0, 3000)}`)
              .setFooter(this.getFooter(user)),
          ],
        })
        .catch((e) => {});
    } else {
      interaction
        .reply({
          embeds: [
            new EmbedBuilder()
              .setColor(this.config.embed.color)
              .setDescription(`${data.substring(0, 3000)}`)
              .setFooter(this.getFooter(user)),
          ],
        })
        .catch((e) => {});
    }
  }
}

module.exports = MusicBot;