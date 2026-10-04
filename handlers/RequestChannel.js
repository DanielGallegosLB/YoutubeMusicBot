const {
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
} = require("discord.js");
const MusicBot = require("./Client");
const { PREFIX: botPrefix } = require("../settings/config");
const {
  searchYoutube,
  isPlaylistURL,
  fetchPlaylistURLsIncrementally,
} = require("./PlaylistFetcher");

// Per-guild promise chain so requests are resolved/queued one by one,
// in the exact order the user posts them — nothing gets dropped.
const requestChains = new Map();

// Listas pendientes de confirmación: id -> { guildId, userId, url, ... }
// El id va dentro del customId de los botones ("plist_next_<id>").
const pendingPlaylists = new Map();
const PL_PROMPT_TTL = 3 * 60 * 1000; // la pregunta vive 3 minutos
let _plSeq = 0;

function enqueue(guildId, fn) {
  const prev = requestChains.get(guildId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  requestChains.set(guildId, next);
  next
    .catch(() => {})
    .finally(() => {
      if (requestChains.get(guildId) === next) requestChains.delete(guildId);
    });
  return next;
}

function escapeRegex(str) {
  return str.replace(/[.*+?${}()|[\]\\]/g, `\\$&`);
}

function cut(text, max = 60) {
  const s = String(text || "");
  return s.length > max ? `${s.substring(0, max)}…` : s;
}

/**
 * @param {MusicBot} client
 */
module.exports = async (client) => {
  client.on(Events.MessageCreate, async (message) => {
    try {
      // Only handle guild messages from humans
      if (!message.guild || !message.id || message.author.bot) return;

      const guildId = message.guild.id;
      const data = await client.music?.get(`${guildId}.music`);
      if (!data) return;

      const musicChannelId = data.channel;
      const musicChannel = message.guild.channels.cache.get(musicChannelId);

      // Only process messages sent in the configured music channel
      if (!musicChannel || message.channelId !== musicChannelId) return;

      // Leave bot messages and the protected queue/player messages alone
      if (data.pmsg === message.id || data.qmsg === message.id || client.previewMessages?.has(message.id)) return;

      // Commands (with prefix or bot mention) are handled by the command handler
      const settings = await client.music.get(guildId).catch(() => null);
      const prefix = settings?.prefix || botPrefix;
      const commandPattern = new RegExp(`^(<@!?${client.user.id}>|${escapeRegex(prefix)})\\s*`);
      if (commandPattern.test(message.content)) return;

      const query = message.content.trim();
      if (!query) return;

      // Serialize processing so every request ends up in the queue in order
      enqueue(guildId, async () => {
        await processRequest(client, message, query);
      });
    } catch (error) {
      client.logger.error("Error handling message in RequestChannel:", error);
    }
  });

  // ── Botones de confirmación de listas ──
  // DistubeHandler ignora los customId desconocidos, así que este listener
  // puede convivir con el suyo sin interferir.
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.isButton() || !interaction.guild || !interaction.guildId) return;
      const customId = interaction.customId || "";
      if (!customId.startsWith("plist_")) return;

      const sep = customId.indexOf("_", 6);
      if (sep < 0) return;
      const action = customId.slice(6, sep);
      const id = customId.slice(sep + 1);
      const pending = pendingPlaylists.get(id);

      if (!pending) {
        return interaction
          .reply({ content: "⏱️ Esta petición de lista ya expiró. Escribí el link otra vez.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
      if (interaction.user.id !== pending.userId) {
        return interaction
          .reply({ content: "🚫 Esa lista no la pidió vos.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }

      pendingPlaylists.delete(id);

      if (action === "cancel") {
        await closePrompt(client, pending, "❌ **Lista cancelada.** No se cargó nada.");
        return;
      }

      const channel =
        interaction.guild.channels.cache.get(pending.voiceChannelId) ||
        interaction.member?.voice?.channel;
      if (!channel) {
        await closePrompt(client, pending, "❌ No encuentro el canal de voz. Entrá a uno y pedí la lista de nuevo.");
        return interaction
          .reply({ content: "❌ Tenés que estar en un canal de voz para reproducir la lista.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }

      await interaction.deferUpdate().catch(() => {});
      await loadPlaylist(client, interaction, pending, channel, action === "next");
    } catch (error) {
      console.error("[Request] Error en los botones de lista:", error);
    }
  });
};

/**
 * Resuelve lo que escribió el usuario en el canal de música.
 */
async function processRequest(client, message, query) {
  const guild = message.guild;
  const guildId = guild.id;

  // Clear any residual explicit-stop flag so playback can start normally
  client.playlistStopped?.delete?.(guildId);

  // Choose the target voice channel: bot's channel > requester's channel > 24/7 channel
  let channel = guild.members.me?.voice?.channel || message.member?.voice?.channel || null;
  if (!channel) {
    const db = await client.music?.get(`${guildId}.vc`).catch(() => null);
    if (db?.enable && db.channel) {
      channel = guild.channels.cache.get(db.channel);
    }
  }

  if (
    !channel ||
    (channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice)
  ) {
    const hint = await message.channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setDescription(
              `ℹ️ Debes estar en un canal de voz para pedir una canción, o activa el modo 24/7.`
            ),
        ],
      })
      .catch(() => null);
    if (hint) setTimeout(() => hint.delete().catch(() => {}), 5000);
    return;
  }

  const isURL = /^(https?:\/\/)/i.test(query);

  // Una LISTA no se agrega sola: se pregunta con botones (al principio / al
  // final / cancelar), porque pueden ser cientos de canciones.
  if (isURL && isPlaylistURL(query)) {
    return askPlaylist(client, message, query, channel);
  }

  return playSong(client, message, query, isURL, channel);
}

/**
 * Canción suelta (nombre o link): se mete SIEMPRE como la siguiente, que es lo
 * que la gente espera al escribir en el canal ("reproducir primero"). Antes se
 * llamaba a distube.play() sin `position`, y DisTube interpreta position<=0
 * como "agregar al final": con una cola larga la canción quedaba al fondo y
 * parecía no funcionar.
 */
async function playSong(client, message, query, isURL, channel) {
  const guildId = message.guild.id;
  const queueBefore = client.distube.getQueue(guildId);
  const hayCancionSondeando = !!queueBefore?.songs?.length;
  const position = hayCancionSondeando ? 1 : 0;

  const playOpts = {
    member: message.member,
    textChannel: message.channel,
    message,
    position,
  };

  let added = false;
  let resolvedQuery = query;
  try {
    await client.distube.voices.join(channel);
    await client.distube.play(channel, isURL ? query : `ytsearch1:${query}`, playOpts);
    added = true;
  } catch (e) {
    // Search API failed (common when YouTube blocks search): fall back to yt-dlp search
    if (!isURL) {
      try {
        const resolved = await searchYoutube(query);
        if (resolved) {
          await client.distube.voices.join(channel);
          await client.distube.play(channel, resolved, playOpts);
          resolvedQuery = resolved;
          added = true;
        }
      } catch (e2) {
        client.logger.error(`[Request] yt-dlp fallback error:`, e2);
      }
    }
    if (!added) client.logger.error(`[Request] No se pudo agregar "${query}":`, e);
  }

  const q = client.distube.getQueue(guildId);
  if (q) {
    client.updateplayer?.(q).catch(() => {});
    client.updatequeue?.(q).catch(() => {});
  }

  // Si NO se pudo resolver, el mensaje del usuario se conserva para que pueda
  // corregirlo; si sí, se borra y queda el aviso.
  if (added) await message.delete().catch(() => {});

  const donde = added
    ? hayCancionSondeando
      ? "como la **siguiente** en la cola"
      : "empezando a reproducir"
    : null;
  const confirm = await message.channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(added ? "#2ECC71" : "#E74C3C")
          .setDescription(
            added
              ? `🎵 **Agregada ${donde}:** ${cut(resolvedQuery)}`
              : `❌ No encontré una canción para: ${cut(query)}`
          ),
      ],
    })
    .catch(() => null);
  if (confirm) setTimeout(() => confirm.delete().catch(() => {}), 8000);
}

/**
 * El link es una lista: se pregunta con botones antes de meterla.
 */
async function askPlaylist(client, message, url, voiceChannel) {
  const id = `${message.author.id}-${Date.now().toString(36)}-${++_plSeq}`;
  const pending = {
    id,
    guildId: message.guild.id,
    userId: message.author.id,
    url,
    voiceChannelId: voiceChannel?.id || null,
    createdAt: Date.now(),
    msg: null,
  };
  pendingPlaylists.set(id, pending);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`plist_next_${id}`)
      .setLabel("⏭️ Como la siguiente")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`plist_end_${id}`)
      .setLabel("➕ Al final de la cola")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`plist_cancel_${id}`)
      .setLabel("❌ Cancelar")
      .setStyle(ButtonStyle.Danger)
  );

  const prompt = await message.channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(client.config?.embed?.color || 0x5865f2)
          .setDescription(
            `🎶 <@${message.author.id}> mandó una **lista**. ¿La reproduzco?\n${cut(url, 120)}`
          ),
      ],
      components: [row],
    })
    .catch(() => null);

  if (prompt) {
    pending.msg = prompt;
    // OJO: el panel de la pregunta se protege del auto-borrado de 10s; si no,
    // los botones morirían antes de que el usuario pueda tocarlos. Se destraba
    // apenas se responde (o cuando expira la pregunta).
    client.previewMessages?.set(prompt.id, true);
  }
  await message.delete().catch(() => {});

  setTimeout(() => {
    if (pendingPlaylists.get(id) === pending) closePrompt(client, pending, "⏱️ La pregunta expiró. La lista no se cargó.");
  }, PL_PROMPT_TTL);
}

/**
 * Cierra el panel de la pregunta: le saca los botones, lo saca de la lista de
 * protegidos y lo borra a los 15s (para que no quede virando en el canal).
 */
async function closePrompt(client, pending, description, keepMs = 15000) {
  pendingPlaylists.delete(pending.id);
  const msg = pending.msg;
  if (!msg || msg.deleted) return;
  client.previewMessages?.delete?.(msg.id);
  try {
    await msg.edit({
      embeds: [
        new EmbedBuilder()
          .setColor(description.startsWith("❌") || description.startsWith("⏱️") ? "#E74C3C" : "#2ECC71")
          .setDescription(description),
      ],
      components: [],
    });
  } catch {}
  setTimeout(() => msg.delete().catch(() => {}), keepMs);
}

/**
 * Carga la lista confirmada. `asNext` = a continuación de lo que está sonando;
 * si no, al final de la cola. Se inserta de a una avanzando el índice para que
 * el ORDEN de la lista se respete dentro del bloque agregado.
 */
async function loadPlaylist(client, interaction, pending, channel, asNext) {
  const guildId = pending.guildId;
  const msg = pending.msg;

  const setPrompt = async (description, color) => {
    if (!msg || msg.deleted) return;
    try {
      await msg.edit({
        embeds: [
          new EmbedBuilder()
            .setColor(color || client.config?.embed?.color || 0x5865f2)
            .setDescription(description),
        ],
        components: [],
      });
    } catch {}
  };

  const queueBefore = client.distube.getQueue(guildId);
  const hayCancionSondeando = !!queueBefore?.songs?.length;
  // asNext y hay cola → índice 1 (la siguiente). Sin cola → 0 (arranca).
  // "Al final" → siempre 0, que DisTube interpreta como push al final.
  let pos = asNext && hayCancionSondeando ? 1 : 0;
  let loaded = 0;
  let failed = 0;

  await setPrompt("⏳ Descargando la lista…");

  client.playlistLoading.set(guildId, true);
  try {
    await fetchPlaylistURLsIncrementally(pending.url, async (batch) => {
      for (const url of batch) {
        if (!client.playlistLoading.get(guildId)) return false;
        try {
          await client.distube.play(channel, url, {
            member: interaction.member,
            textChannel: interaction.channel,
            position: pos,
          });
          loaded++;
          if (asNext && hayCancionSondeando) pos++;
        } catch (e) {
          failed++;
        }
        if (loaded % 10 === 0) {
          await setPrompt(`⏳ Cargando lista… **${loaded}** canciones agregadas.`);
        }
      }
    });
  } catch (e) {
    console.error("[Request] Error cargando la lista:", e);
  } finally {
    client.playlistLoading.delete(guildId);
  }

  const q = client.distube.getQueue(guildId);
  if (q) {
    client.updateplayer?.(q).catch(() => {});
    client.updatequeue?.(q).catch(() => {});
  }

  const donde = !asNext
    ? "al final de la cola"
    : hayCancionSondeando
      ? "a continuación de la canción actual"
      : "empezando a reproducir";

  await setPrompt(
    loaded
      ? `✅ **Lista cargada:** ${loaded} canciones ${failed ? `(${failed} no se pudieron cargar) ` : ""}· ${donde}.`
      : `❌ No se pudo cargar ninguna canción de la lista.`,
    loaded ? "#2ECC71" : "#E74C3C",
    15000
  );

  if (msg && !msg.deleted) {
    client.previewMessages?.delete?.(msg.id);
    setTimeout(() => msg.delete().catch(() => {}), 15000);
  }
}