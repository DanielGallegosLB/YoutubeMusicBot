const { Song, Playlist } = require("distube");

const EMBED_RE = /^https?:\/\/(?:open|play|embed)\.spotify\.com\/(?:embed\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)/;
const TRACK_URI_RE = /spotify:track:([A-Za-z0-9]+)/;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function fetchEmbedHtml(type, id) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  return res.text();
}

function parseEntity(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    return data?.props?.pageProps?.state?.data?.entity || null;
  } catch (_) {
    return null;
  }
}

function coverUrl(entity) {
  try {
    return entity?.coverArt?.sources?.find((s) => s.url)?.url;
  } catch (_) {
    return undefined;
  }
}

function artistsName(subtitle) {
  if (Array.isArray(subtitle)) return subtitle.join(", ");
  if (typeof subtitle === "string" && subtitle.trim()) return subtitle.trim();
  return "Artista desconocido";
}

function trackDuration(duration) {
  return typeof duration === "number" ? duration / 1e3 : undefined;
}

function buildSong(plugin, entity, id, type, thumbnail, options) {
  const trackId = entity.id || id;
  const artists = Array.isArray(entity.artists)
    ? entity.artists.map((a) => a.name).filter(Boolean).join(", ")
    : artistsName(entity.subtitle);
  return new Song(
    {
      plugin,
      source: "spotify",
      playFromSource: false,
      id: trackId,
      name: entity.title || entity.name,
      url: `https://open.spotify.com/track/${trackId}`,
      thumbnail,
      uploader: { name: artists },
      duration: trackDuration(entity.duration),
    },
    options
  );
}

/**
 * Resolver de respaldo para enlaces de Spotify.
 * El plugin @distube/spotify depende de spotify-url-info, que parsea
 * etiquetas `og:` del HTML del embed; Spotify las eliminó, así que
 * el scraping oficial falla. Aquí heredamos el dato real que Spotify
 * sí sirve dentro de `__NEXT_DATA__.props.pageProps.state.data.entity`.
 */
async function resolveSpotifyFallback(plugin, url, options = {}) {
  const match = url.match(EMBED_RE);
  if (!match) return null;
  const type = match[1];
  const id = match[2];
  const html = await fetchEmbedHtml(type, id);
  const entity = parseEntity(html);
  if (!entity) return null;

  const thumbnail = coverUrl(entity);

  if (entity.type === "track" || type === "track") {
    return buildSong(plugin, entity, id, type, thumbnail, options);
  }

  const trackList = Array.isArray(entity.trackList) ? entity.trackList : [];
  if (!trackList.length) return null;

  return new Playlist(
    {
      source: "spotify",
      name: entity.title || entity.name,
      url,
      thumbnail,
      songs: trackList.map((t) => {
        const tid = (String(t.uri || "").match(TRACK_URI_RE) || [])[1] || "";
        return new Song(
          {
            plugin,
            source: "spotify",
            id: tid,
            playFromSource: false,
            name: t.title,
            thumbnail: coverUrl(t) || thumbnail,
            uploader: { name: artistsName(t.subtitle) },
            url: `https://open.spotify.com/track/${tid}`,
            duration: trackDuration(t.duration),
          },
          options
        );
      }),
    },
    options
  );
}

module.exports = resolveSpotifyFallback;