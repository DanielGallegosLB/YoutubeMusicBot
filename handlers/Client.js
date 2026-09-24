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
          format: "bestaudio/best",
          extractorArgs: "youtube:player_client=web_embedded,android",
        };
        try {
          const cookiePath = require("path").join(__dirname, "../yt-cookies.txt");
          if (require("fs").existsSync(cookiePath) && require("fs").statSync(cookiePath).size > 10) {
            opts.cookies = cookiePath;
          }
        } catch (_) {}
        return opts;
      })(),
    });

    this.searcher = new YouTubePlugin();
    this.searcher.getStreamURL = (song) => ytDlpPlugin.getStreamURL(song);
    this.searcher.validate = () => false;
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