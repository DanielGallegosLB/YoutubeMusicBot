const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const PlaylistStore = require("./PlaylistStore");

const MAX_HISTORY = 20;
const MAX_SELECT_OPTIONS = 25;

const FAVORITES_PLAYLIST = "Canciones Favoritas";

const YTDLP_PATH = path.join(
  process.cwd(),
  "node_modules/@distube/yt-dlp/bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

function fetchPlaylistInfo(playlistUrl) {
  return new Promise((resolve) => {
    const cookiePath = path.join(process.cwd(), "yt-cookies.txt");
    const args = [
      "--flat-playlist",
      "--playlist-items", "1-1",
      "--print", "%(playlist_title)s\t%(id)s",
      "--no-warnings",
      "--ignore-errors",
      "--no-check-certificates",
      "--js-runtimes", "node",
      playlistUrl,
    ];
    if (fs.existsSync(cookiePath)) {
      args.push("--cookies", cookiePath);
    }
    const proc = spawn(YTDLP_PATH, args);
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const line = stdout.trim().split("\n")[0];
      if (!line) return resolve(null);
      const [title, id] = line.split("\t");
      const thumbnail =
        id && id !== "NA" ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
      resolve({ title: title || null, thumbnail });
    });
  });
}

module.exports = {
  async recordPlaylistPlay(client, guildId, userId, playlistUrl, playlistName, channelId, thumbnail) {
    const key = `${guildId}.userHistory.${userId}`;
    await client.music.ensure(key, { playlistHistory: [], noSuggestions: false });
    const data = await client.music.get(key);
    const history = data.playlistHistory || [];
    history.unshift({ url: playlistUrl, name: playlistName, timestamp: Date.now(), thumbnail: thumbnail || null });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await client.music.set(`${key}.playlistHistory`, history);
    if (channelId) await client.music.set(`${key}.lastChannelId`, channelId);
  },

  async recordSongPlay(client, guildId, userId, song, user, channelId) {
    if (!song || !userId) return;
    const track = PlaylistStore.serializeSong(song, user);
    if (!track) return;
    await PlaylistStore.create(client, guildId, userId, FAVORITES_PLAYLIST);
    await PlaylistStore.addTracks(client, guildId, userId, FAVORITES_PLAYLIST, [track]);
    if (channelId) {
      const key = `${guildId}.userHistory.${userId}`;
      await client.music.ensure(key, { playlistHistory: [], noSuggestions: false });
      await client.music.set(`${key}.lastChannelId`, channelId);
    }
  },

  async setNoSuggestions(client, guildId, userId, value) {
    const key = `${guildId}.userHistory.${userId}`;
    await client.music.ensure(key, { playlistHistory: [], noSuggestions: false });
    await client.music.set(`${key}.noSuggestions`, value);
  },

  async isNoSuggestions(client, guildId, userId) {
    const key = `${guildId}.userHistory.${userId}`;
    const data = await client.music.get(key);
    return data?.noSuggestions || false;
  },

  async getLastChannelId(client, guildId, userId) {
    const key = `${guildId}.userHistory.${userId}`;
    const data = await client.music.get(key);
    return data?.lastChannelId || null;
  },

  async getUniquePlayedPlaylists(client, guildId, userId) {
    const key = `${guildId}.userHistory.${userId}`;
    const data = await client.music.get(key);
    const history = data?.playlistHistory || [];
    const seen = new Map();
    for (const entry of history) {
      if (entry.url && !seen.has(entry.url)) {
        seen.set(entry.url, {
          url: entry.url,
          name: entry.name || entry.url,
          lastPlayed: entry.timestamp,
          thumbnail: entry.thumbnail || null,
        });
      }
    }
    return Array.from(seen.values());
  },

  async backfillPlaylistNames(client, guildId, userId) {
    const key = `${guildId}.userHistory.${userId}`;
    const data = await client.music.get(key);
    const history = data?.playlistHistory || [];
    if (!history.length) return;

    const urlEntries = history.filter(
      (e) => e.url && /^https?:\/\//i.test(e.name || "")
    );
    if (!urlEntries.length) return;

    const uniqueUrls = [...new Set(urlEntries.map((e) => e.url))];
    const info = new Map();
    for (const url of uniqueUrls) {
      try {
        const res = await fetchPlaylistInfo(url);
        if (res?.title) info.set(url, res);
      } catch {}
    }
    if (!info.size) return;

    const seen = new Map();
    for (const entry of history) {
      if (entry.url && seen.has(entry.url)) continue;
      if (!entry.url) {
        seen.set(entry, entry);
        continue;
      }
      seen.set(entry.url, entry);
    }

    const newHistory = [...seen.values()];
    let changed = newHistory.length !== history.length;
    for (const entry of newHistory) {
      if (!entry.url || !info.has(entry.url)) continue;
      const res = info.get(entry.url);
      if (entry.name !== res.title) {
        entry.name = res.title;
        changed = true;
      }
      if (!entry.thumbnail && res.thumbnail) {
        entry.thumbnail = res.thumbnail;
        changed = true;
      }
    }
    if (changed) await client.music.set(`${key}.playlistHistory`, newHistory);
  },

  async buildPreviewEmbed(client, guildId, userId) {
    this.backfillPlaylistNames(client, guildId, userId).catch((e) => {
      const msg = e?.message || e;
      if (client.logger?.warn) client.logger.warn(`[UserHistory] Backfill error:`, msg);
      else console.warn("[UserHistory] Backfill error:", msg);
    });

    const playedPlaylists = await this.getUniquePlayedPlaylists(client, guildId, userId);
    const playlists = await PlaylistStore.getAll(client, guildId, userId);
    const favs = playlists[FAVORITES_PLAYLIST] || [];
    const otherPlaylists = Object.entries(playlists).filter(([name]) => name !== FAVORITES_PLAYLIST);

    const hasPlayed = playedPlaylists.length > 0;
    const hasFavs = favs.length > 0;
    const hasOther = otherPlaylists.length > 0;

    if (!hasPlayed && !hasFavs && !hasOther) return null;

    const fields = [];

    if (hasPlayed) {
      for (const pl of playedPlaylists.slice(0, 10)) {
        fields.push({
          name: `\u200b`,
          value: `**[${pl.name}](${pl.url})**`,
          inline: true,
        });
      }
    }

    if (hasFavs) {
      const totalDuration = favs.reduce((sum, t) => sum + (t.duration || 0), 0);
      const hrs = Math.floor(totalDuration / 3600);
      const mins = Math.floor((totalDuration % 3600) / 60);
      const durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
      const songList = favs.slice(0, 15).map((t, i) => `${i + 1}. ${t.name || "Desconocido"}`).join("\n");
      const extra = favs.length > 15 ? `\n> ... y ${favs.length - 15} más` : "";
      fields.push({
        name: `\u200b`,
        value: `**Canciones Favoritas** (${favs.length} - ${durationStr})\n${songList}${extra}`,
        inline: false,
      });
    }

    if (hasOther) {
      for (const [name, tracks] of otherPlaylists.slice(0, 5)) {
        const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
        const hrs = Math.floor(totalDuration / 3600);
        const mins = Math.floor((totalDuration % 3600) / 60);
        const durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        fields.push({
          name: `\u200b`,
          value: `**${name}**\n> ${tracks.length} canciones - ${durationStr}`,
          inline: true,
        });
      }
    }

    if (fields.length === 0) return null;

    const firstThumb = playedPlaylists.find((p) => p.thumbnail)?.thumbnail;

    const embed = new EmbedBuilder()
      .setColor(client.config.embed.color)
      .setTitle("Tus listas guardadas")
      .setDescription("Selecciona una lista del menú o reproduce tus favoritos.")
      .addFields(fields);

    if (firstThumb) embed.setThumbnail(firstThumb);

    return embed;
  },

  async buildPreviewComponents(client, guildId, userId) {
    const playedPlaylists = await this.getUniquePlayedPlaylists(client, guildId, userId);
    const playlists = await PlaylistStore.getAll(client, guildId, userId);
    const otherPlaylists = Object.entries(playlists).filter(([name]) => name !== FAVORITES_PLAYLIST);

    const options = [];

    for (const pl of playedPlaylists) {
      if (options.length >= MAX_SELECT_OPTIONS) break;
      options.push({
        label: pl.name.substring(0, 100),
        description: `Lista reproducida anteriormente`,
        value: `url:${pl.url}`,
      });
    }

    for (const [name, tracks] of otherPlaylists) {
      if (options.length >= MAX_SELECT_OPTIONS) break;
      options.push({
        label: name.substring(0, 100),
        description: `${tracks.length} canciones`,
        value: `store:${name}`,
      });
    }

    const components = [];

    if (options.length > 0) {
      components.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("preview_select_playlist")
            .setPlaceholder("Selecciona una lista para reproducir...")
            .addOptions(options)
        )
      );
    }

    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("suggest_favorites")
          .setLabel("Reproducir Favoritos")
          .setEmoji("❤️")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`no_suggest_${userId}`)
          .setLabel("No notificar más")
          .setEmoji("🔕")
          .setStyle(ButtonStyle.Secondary)
      )
    );

    return components;
  },
};
