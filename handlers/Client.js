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
const { SpotifyPlugin } = require("@distube/spotify");
const { SoundCloudPlugin } = require("@distube/soundcloud");
const { filters, options } = require("../settings/config");
const { YtDlpPlugin } = require("@distube/yt-dlp");
const Logger = require("./Logger");

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
    this.mcategories = fs.readdirSync("./Commands/Message");
    this.scategories = fs.readdirSync("./Commands/Slash");
    this.temp = new Collection();
    this.previewMessages = new Collection();
    this.config = require("../settings/config");
    this.logger = Logger;

    this.distube = new Distube(this, {
      emitNewSongOnly: true,
      nsfw: false,
      savePreviousSongs: true,
      joinNewVoiceChannel: false,
      customFilters: filters,
      plugins: [
        new SpotifyPlugin(),
        new SoundCloudPlugin(),
        new YtDlpPlugin({
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
              extractorArgs: "youtube:player_client=web_embedded",
            };
            try {
              const cookiePath = require("path").join(__dirname, "../yt-cookies.txt");
              if (require("fs").existsSync(cookiePath) && require("fs").statSync(cookiePath).size > 10) {
                opts.cookies = cookiePath;
              }
            } catch (_) {}
            return opts;
          })(),
        }),
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
      "DistubeHandler",
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