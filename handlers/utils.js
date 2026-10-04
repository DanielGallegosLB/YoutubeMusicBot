const MusicBot = require("./Client");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  CommandInteraction,
  ChannelType,
  Guild,
  Events,
  MessageFlags,
} = require("discord.js");
const { Queue, Song } = require("distube");
const PlaylistStore = require("./PlaylistStore");
const AutoDjSource = require("./Autodjsource");

/**
 *
 * @param {MusicBot} client
 */
module.exports = async (client) => {
  // code
  client.QUEUE_PER_PAGE = 10;
  /**
   *
   * @param {Queue} queue
   */
  client.buttons = (state, queue) => {
    // Determine dynamic states when queue is available
    const track = queue?.songs?.[0];
    const isLive = !!track?.isLive;
    const duration = Number(track?.duration || 0);
    const pos = Number(queue?.currentTime || 0);
  const nearStart = pos <= 1;
    const nearEnd = duration ? pos >= Math.max(0, duration - 1) : false;
    const hasNext = (queue?.songs?.length || 0) > 1;
    const hasPrev = (queue?.previousSongs?.length || 0) > 0;
    const canSeek = !isLive && duration > 0;

    // Loop visuals
    const loopMode = Number(queue?.repeatMode || 0); // 0 off, 1 song, 2 queue
    const isLoopSong = loopMode === 1;
    const isLoopQueue = loopMode === 2;

    const loopSongStyle = isLoopSong ? ButtonStyle.Success : ButtonStyle.Secondary;
    const loopQueueStyle = isLoopQueue ? ButtonStyle.Success : ButtonStyle.Secondary;

    // Autoplay visuals
    const autoplayOn = !!queue?.autoplay;
    const autoplayStyle = autoplayOn ? ButtonStyle.Success : ButtonStyle.Secondary;

    // Play/Pause visuals
    const isPaused = !!queue?.paused;
    const prEmoji = isPaused ? "▶️" : "⏸️";
    const prLabel = isPaused ? "Play" : "Pause";

    // Helper: apply base disabled state
    const dis = (d) => (state ? true : d);

    // Row 1: Previous • -10s • Play/Pause • +10s • Next
    const row1 = new ActionRowBuilder().addComponents([
      new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setCustomId("previous")
        .setEmoji(client.config.emoji.previous_song)
        .setLabel("Prev")
        .setDisabled(dis(!hasPrev)),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("rewind10")
        .setEmoji("⏪")
        .setLabel("-10s")
        .setDisabled(dis(!canSeek)),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setCustomId("pauseresume")
        .setEmoji(prEmoji)
        .setLabel(prLabel)
        .setDisabled(state),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("forward10")
        .setEmoji("⏩")
        .setLabel("+10s")
        .setDisabled(dis(!canSeek || nearEnd)),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setCustomId("skip")
        .setEmoji(client.config.emoji.next_song)
        .setLabel("Next")
        .setDisabled(dis(!hasNext)),
    ]);

    // Row 2: Stop • Shuffle • Loop Song • Loop Queue • Autoplay
    const row2 = new ActionRowBuilder().addComponents([
      new ButtonBuilder()
        .setStyle(ButtonStyle.Danger)
        .setCustomId("stop")
        .setEmoji(client.config.emoji.stop)
        .setLabel("Stop")
        .setDisabled(state),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("shuffle")
        .setEmoji(client.config.emoji.shuffle)
        .setLabel("Shuffle")
        .setDisabled(dis((queue?.songs?.length || 0) <= 2)),
      new ButtonBuilder()
        .setStyle(loopSongStyle)
        .setCustomId("loop_song")
        .setEmoji("🔂")
        .setLabel("Song")
        .setDisabled(state),
      new ButtonBuilder()
        .setStyle(loopQueueStyle)
        .setCustomId("loop_queue")
        .setEmoji("🔁")
        .setLabel("Queue")
        .setDisabled(state),
      new ButtonBuilder()
        .setStyle(autoplayStyle)
        .setCustomId("autoplay")
        .setEmoji(client.config.emoji.autoplay)
        .setLabel("Autoplay")
        .setDisabled(state),
    ]);

    // Row 3: Auto DJ 🛸 • Like 👍 • Dislike 👎 • Favorita ⭐
    // Auto DJ visuals (toggle state)
    const autoDjOn = !!client.autoDj?.get(queue?.textChannel?.guildId || queue?.guildId);
    const autoDjStyle = autoDjOn ? ButtonStyle.Success : ButtonStyle.Primary;
    const row3 = new ActionRowBuilder().addComponents([
      new ButtonBuilder()
        .setStyle(autoDjStyle)
        .setCustomId("autodj")
        .setEmoji("🛸")
        .setLabel(autoDjOn ? "Auto DJ: ON" : "Auto DJ")
        .setDisabled(dis(!track)),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("player_like")
        .setEmoji("👍")
        .setLabel("Like")
        .setDisabled(dis(!track)),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("player_dislike")
        .setEmoji("👎")
        .setLabel("Dislike")
        .setDisabled(dis(!track)),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Success)
        .setCustomId("favorite_btn")
        .setEmoji("⭐")
        .setLabel("Favorita")
        .setDisabled(dis(!track)),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Danger)
        .setCustomId("autodj_skipban")
        .setEmoji("🚫")
        .setLabel("No AutoDJ")
        .setDisabled(dis(!track)),
    ]);

    return [row1, row2, row3];
  };

  // Programa el auto-borrado de confirmaciones efímeras. Tiempo configurable
  // desde settings/config.js → options.ephemeralTTL (ms). 0 = no borrar.
  //
  // Uso: client.scheduleDelete(msg, interaction) donde `msg` es el RESULTADO de
  // interaction.reply()/interaction.followUp(). Así se borra el mensaje CONCRETO
  // (via interaction.webhook.deleteMessage), porque interaction.deleteReply()
  // solo borra @original y deja vivos los followUp ephemeral.
  // Si `msg` es una interaction (compat), se conserva el viejo deleteReply().
  client.scheduleDelete = (target, interaction) => {
    if (!target) return;
    const ttl = client.config?.options?.ephemeralTTL || 10000;
    if (!ttl || ttl <= 0) return;
    const isInteraction = typeof target?.deleteReply === "function";
    const msgId = isInteraction ? null : target?.id;
    const hook = !isInteraction ? interaction?.webhook : null;
    // Canal del mensaje: en canales intocables no se borra NADA, tampoco una
    // efímera (si no se puede resolver el canal, se borra como antes).
    const guildId = target?.guildId || interaction?.guildId || target?.channel?.guild?.id || null;
    const channelId = target?.channelId || target?.channel_id || target?.channel?.id || null;
    setTimeout(() => {
      Promise.resolve(
        channelId && client.isNoCleanupChannel
          ? client.isNoCleanupChannel(guildId, channelId).catch(() => false)
          : false
      ).then((skip) => {
        if (skip) return;
        try {
          if (!isInteraction && msgId && hook) {
            hook.deleteMessage(msgId).catch(() => {});
          } else if (!isInteraction && typeof target.delete === "function") {
            target.delete().catch(() => {});
          } else if (isInteraction) {
            target.deleteReply().catch(() => {});
          }
        } catch {}
      });
    }, ttl);
  };
  // ------------------------------------------------------------------
  //  Política de borrado de mensajes (configurable).
  //
  //  cleanup:   canales donde se borran los mensajes del bot de TODO tipo
  //             (respuestas de slash, confirmaciones, etc.), salvo el panel
  //             del reproductor, la cola y los previews protegidos.
  //  noCleanup: canales intocables: NO se borra nada, ni siquiera una
  //             respuesta efímera. Tiene prioridad sobre `cleanup`.
  //
  //  Los valores por defecto salen de settings/config.js (channels.cleanup /
  //  channels.noCleanup) y cada guild puede sobrescribirlos: el dashboard
  //  los escribe en `${guildId}.music.cleanupChannels` y
  //  `${guildId}.music.noCleanupChannels` a través del puente de comandos.
  // ------------------------------------------------------------------
  const toIdList = (value) =>
    (Array.isArray(value) ? value : [value])
      .filter((id) => id !== null && id !== undefined && id !== "")
      .map(String);

  if (!client._channelPolicyCache) client._channelPolicyCache = new Map();

  client.getChannelPolicy = async (guildId) => {
    const cached = client._channelPolicyCache.get(guildId);
    if (cached && Date.now() - cached.at < 5000) return cached.data;

    const cfg = client.config?.channels || {};
    let cleanup = toIdList(cfg.cleanup);
    let noCleanup = toIdList(cfg.noCleanup);

    if (guildId) {
      const meta = await client.music?.get(`${guildId}.music`).catch(() => null);
      // Una lista vacía NO pisa los valores de config.js: significa "usar los
      // defaults". Para vaciarla de verdad hay que tocar settings/config.js.
      const override = (v) => Array.isArray(v) && v.length > 0;
      if (override(meta?.cleanupChannels)) cleanup = toIdList(meta.cleanupChannels);
      if (override(meta?.noCleanupChannels)) noCleanup = toIdList(meta.noCleanupChannels);

      // El canal del reproductor también entra en la lista de limpieza,
      // salvo que el guild lo haya marcado como intocable.
      const playerChannel = meta?.channel ? String(meta.channel) : null;
      if (playerChannel && !noCleanup.includes(playerChannel)) cleanup.push(playerChannel);
    }

    const data = {
      cleanup: [...new Set(cleanup)].filter((id) => !noCleanup.includes(id)),
      noCleanup: [...new Set(noCleanup)],
    };
    client._channelPolicyCache.set(guildId, { at: Date.now(), data });
    return data;
  };

  client.isNoCleanupChannel = async (guildId, channelId) => {
    if (!channelId) return false;
    const { noCleanup } = await client.getChannelPolicy(guildId);
    return noCleanup.includes(String(channelId));
  };

  console.log(
    `[Utils] scheduleDelete listo (ephemeralTTL=${client.config?.options?.ephemeralTTL ?? 10000}ms)`
  );

  // ------------------------------------------------------------------
  //  Auto-borrado GLOBAL de mensajes.
  //
  //  Antes solo se borraban las 5 respuestas que llaman a scheduleDelete()
  //  a mano, asi que casi todos los `ephemeral: true` se quedaban pegados
  //  en el canal hasta que el usuario los borraba. Y en el canal del
  //  reproductor se acumulaban mensajes viejos.
  //
  //  Aqui se cubren los dos casos de una sola pasada:
  //    1. Respuestas efimeras (flags 64): se borran a los N ms.
  //    2. Cualquier mensaje del bot en un canal de limpieza: tambien.
  //
  //  Los canales Saleen de client.getChannelPolicy(): `cleanup` (por defecto
  //  settings/config.js channels.cleanup + el canal del reproductor) y
  //  `noCleanup`, donde no se borra absolutamente nada.
  //
  //  EXCEPCION: el mensaje del panel de reproduccion (client.temp) nunca
  //  se borra, porque es el ancla de todos los botones; si se fuera, el
  //  reproductor quedaria sin controles.
  // ------------------------------------------------------------------
  if (!client._autoDeleteReady) {
    client._autoDeleteReady = true;
    if (!client._playerChannels) client._playerChannels = new Map();

    // 0 = nunca borrar (por eso `??` y no `||`: con `||` un 0 caía al default).
    const ttlDe = (value, def) =>
      typeof value === "number" && Number.isFinite(value) ? value : def;
    const ttlEfimera = () => ttlDe(client.config?.options?.ephemeralTTL, 10000);
    const ttlLimpieza = () => ttlDe(client.config?.options?.cleanupTTL, 10000);

    // El panel (client.temp) NO se borra jamas.
    const isPanel = (message) => {
      try {
        return client.temp?.get(message.guildId) === message.id;
      } catch {
        return false;
      }
    };

    // Resuelve (y memoriza) el canal donde vive el panel de este guild.
    // Se relee siempre el panel real: si se recrea en otro canal, el valor
    // cacheado se corrige solo (si no, se borrarian mensajes del canal viejo).
    const playerChannelId = (message) => {
      if (!message.guildId) return null;
      const panelId = client.temp?.get(message.guildId);
      if (!panelId) {
        client._playerChannels.delete(message.guildId);
        return null;
      }
      const cached = message.channel?.messages?.cache?.get(panelId);
      if (cached) {
        if (client._playerChannels.get(message.guildId) !== cached.channelId) {
          client._playerChannels.set(message.guildId, cached.channelId);
        }
        return cached.channelId;
      }
      return client._playerChannels.get(message.guildId) || null;
    };

    // Copia corta de `${guildId}.music` para saber qué mensajes NO se deben
    // borrar (pmsg, qmsg). Leerlo por cada mensaje costaba ~80ms cada vez.
    if (!client._musicMetaCache) client._musicMetaCache = new Map();
    const musicMeta = async (guildId) => {
      const c = client._musicMetaCache.get(guildId);
      if (c && Date.now() - c.at < 10000) return c.data;
      const data = await client.music?.get(`${guildId}.music`).catch(() => null);
      const val = data || {};
      client._musicMetaCache.set(guildId, { at: Date.now(), data: val });
      return val;
    };

    // Mensajes que el bot necesita vivos: el panel de reproducción, el de la
    // cola y las previews. Es el MISMO criterio que usan RequestChannel.js:47
    // y ChannelCleaner.js:31; sin esto el borrado a 10s se llevaba por delante
    // la cola entera y sus botones.
    const isProtected = async (message) => {
      if (!message?.guildId) return true;
      if (client.temp?.get(message.guildId) === message.id) return true;
      if (client.previewMessages?.has?.(message.id)) return true;
      const meta = await musicMeta(message.guildId);
      return meta.pmsg === message.id || meta.qmsg === message.id;
    };

    client.on(Events.MessageCreate, async (message) => {
      try {
        if (!message) return;
        // Las respuestas a interacciones llegan con webhookId y pueden tener
        // author.bot === false, asi que no se descartan solo por eso.
        if (message.author?.bot !== true && !message.webhookId) return;
        if (isPanel(message)) return;

        const esEfimera = Boolean(message.flags?.bitfield & MessageFlags.Ephemeral);

        // Política de canales: en `noCleanup` no se borra NADA (ni siquiera una
        // efímera). En `cleanup` se borran los mensajes del bot de todo tipo; el
        // canal del panel se consulta también por si quedó fuera de la lista.
        const { cleanup, noCleanup } = await client.getChannelPolicy(message.guildId);
        if (noCleanup.includes(message.channelId)) return;
        const esCanalLimpieza =
          cleanup.includes(message.channelId) ||
          playerChannelId(message) === message.channelId;
        if (!esEfimera && !esCanalLimpieza) return;

        const ttl = esEfimera ? ttlEfimera() : ttlLimpieza();
        if (!ttl || ttl <= 0) return;

        // Solo borra lo que manda ESTE bot. Nunca toca mensajes de otras personas.
        const propio =
          message.webhookId === client.application?.id || message.author?.bot === true;
        if (!propio) return;

        setTimeout(async () => {
          // OJO: la proteccion se re-evalua AQUI, no al recibir el mensaje.
          // El panel se registra en client.temp DESPUES de enviarlo
          // (DistubeEvents.js), asi que al crearse todavia no esta protegido:
          // si se decidiera aqui, se borraria el panel y el reproductor se
          // quedaria sin botones.
          try {
            if (message.deleted) return;
            if (await isProtected(message)) return;
            await message.delete();
          } catch {}
        }, ttl);
      } catch {}
    });

    console.log(
      `[Utils] auto-borrado global listo (efimeras=${ttlEfimera()}ms, canales de limpieza=${ttlLimpieza()}ms)`
    );
  }

  client.editPlayerMessage = async (channel) => {
    try {
      const ID = client.temp.get(channel.guild.id);
      if (!ID) return;

      let playembed =
        channel.messages.cache.get(ID) ||
        (await channel.messages.fetch(ID).catch(() => null));
      if (!playembed) return;

      const embeds = playembed?.embeds?.[0];
      if (embeds) {
        playembed
          .edit({
            embeds: [
              new EmbedBuilder(embeds.data).setFooter({
                text: `⛔️ SONG & QUEUE ENDED!`,
                iconURL: channel.guild.iconURL({ dynamic: true }),
              }),
            ],
            components: client.buttons(true, null),
          })
          .catch(() => {});
      }
    } catch (e) {}
  };

  /**
   *
   * @param {Queue} queue
   * @returns
   */
  client.getQueueEmbeds = async (queue) => {
    const guild = client.guilds.cache.get(queue.textChannel.guildId);
    let maxTracks = 10;
    try {
      const stored = await client.music.get(`${guild.id}.qlimit`);
      const n = Number(stored);
      if (Number.isInteger(n) && n > 0 && n <= 50) maxTracks = n;
    } catch (_e) {}
    const tracks = queue.songs.slice(1); // Make a shallow copy and remove the first song

    const quelist = [];
    for (let i = 0; i < tracks.length; i += maxTracks) {
      const songs = tracks.slice(i, i + maxTracks);
      quelist.push(
        songs
          .map(
            (track, index) =>
              `\` ${i + index + 1}. \` ** ${client.getTitle(track)}** - \`${
                track.isLive
                  ? `LIVE STREAM`
                  : track.formattedDuration.split(` | `)[0]
              }\` \`${track.user.tag}\``
          )
          .join(`\n`)
      );
    }

    const embeds = [];
    for (let i = 0; i < quelist.length; i++) {
      const desc = String(quelist[i]).substring(0, 2048);
      embeds.push(
        new EmbedBuilder()
          .setAuthor({
            name: `Queue for ${guild.name}  -  [ ${tracks.length} Tracks ]`,
            iconURL: guild.iconURL({ dynamic: true }),
          })
          .setColor(client.config.embed.color)
          .setDescription(desc)
      );
    }
    return embeds;
  };

  client.status = (queue) =>
    `Volume: ${queue.volume}% • Status : ${
      queue.paused ? "Paused" : "Playing"
    } • Loop:  ${
      queue.repeatMode === 2 ? `Queue` : queue.repeatMode === 1 ? `Song` : `Off`
    } •  Autoplay: ${queue.autoplay ? `On` : `Off`} `;

  // embeds
  /**
   *
   * @param {Guild} guild
   */
  client.queueembed = (guild) => {
    let embed = new EmbedBuilder()
      .setColor(client.config.embed.color)
      .setAuthor({ name: `Music Queue` })
      .setDescription("The music queue is empty.");

    return embed;
  };

  /**
   *
   * @param {Guild} guild
   */
  client.playembed = (guild) => {
    const embed = new EmbedBuilder()
      .setColor(client.config.embed.color)
      .setAuthor({
        name: "Join a Voice Channel and Type Song Link/Name to Play",
        iconURL: client.user.displayAvatarURL(),
      })
      .setImage(
        guild.banner
          ? guild.bannerURL({ size: 4096 })
          : "http://cdn.wallpaperinhd.net/wp-content/uploads/2018/11/02/Music-Background-Wallpaper-025.jpg"
      )
      .setFooter({
        text: guild.name,
        iconURL: guild.iconURL(),
      });

    return embed;
  };

  /**
   *
   * @param {Client} client
   * @param {Guild} guild
   * @returns
   */
  /**
   * Trae un mensaje del panel distinguiendo "NO EXISTE" de "falló el fetch".
   *   - Message  → existe
   *   - null     → Discord confirmó que no existe (10008 Unknown Message) o no hay id
   *   - undefined→ error transitorio (rate limit, timeout, red, permisos):
   *                NO se debe recrear nada, solo reintentar más tarde.
   * Antes, cualquier error del fetch se trataba como "mensaje borrado" y el
   * Self-Repair recreaba paneles que sí existían.
   */
  client.fetchPanelMessage = async (channel, id) => {
    if (!id) return null;
    const cached = channel.messages.cache.get(id);
    if (cached) return cached;
    try {
      return await channel.messages.fetch(id);
    } catch (e) {
      if (e?.code === 10008 || e?.status === 404) return null;
      client.logger.warn(`[Self-Repair] fetch transitorio falló (${e?.code || e?.status || e?.message}), no se recrea.`);
      return undefined;
    }
  };

  // Stats de canción con caché corta (20s) + tope: acelera el render del embed
  // fijo y evita martillar a Mongo en cada transición/refill.
  const _statsCache = new Map(); // `${guild}|${url}` -> { at, data }
  const EMPTY_STATS = { likes: 0, dislikes: 0, plays: 0, likedBy: [], dislikedBy: [], owners: [] };
  const hasRealStats = (d) =>
    !!d && (d.likes > 0 || d.dislikes > 0 || d.plays > 0 ||
      (d.likedBy || []).length > 0 || (d.dislikedBy || []).length > 0 || (d.owners || []).length > 0);
  const statsWithCache = async (client, guildId, url, allPlaylists, guild = null) => {
    const k = `${guildId}|${url}`;
    const c = _statsCache.get(k);
    // 20s con stats reales, 15s sin ellas. Antes eran 3s: se re-consultaba el
    // store cada 3 segundos para cada canción sin likes/plays, que es lo que
    // más se repite en el AutoDJ.
    if (c && Date.now() - c.at < (hasRealStats(c.data) ? 20000 : 15000)) return c.data;
    let timedOut = false;
    const data = await Promise.race([
      Promise.resolve(PlaylistStore.getGlobalTrackStats(client, guildId, url, allPlaylists, guild).catch(() => EMPTY_STATS)),
      new Promise((r) => setTimeout(() => { timedOut = true; r(EMPTY_STATS); }, 4000)),
    ]);
    // Un corte por timeout (o una lectura que volvió vacía) NO se cachea: si se
    // guardaba, el panel se quedaba sin stats hasta que expirara la entrada y
    // el parpadeo era constante. Solo se cachea cuando vino algo real.
    if (timedOut) return hasRealStats(c?.data) ? c.data : data;
    if (!hasRealStats(data) && hasRealStats(c?.data)) return c.data;
    _statsCache.set(k, { at: Date.now(), data });
    if (_statsCache.size > 2000) {
      const now = Date.now();
      for (const [kk, vv] of _statsCache) if (now - vv.at > 60000) _statsCache.delete(kk);
    }
    return data;
  };

  // El objeto playlists del guild es GRANDE; fetchearlo entero en cada transición
  // (para los 👍/dueños del embed de cola) es lento. Caché corta (5s) + tope.
  const _playlistsCache = new Map(); // guildId -> { at, data }
  const allPlaylistsWithCache = async (client, guildId) => {
    const c = _playlistsCache.get(guildId);
    if (c && Date.now() - c.at < 5000) return c.data;
    const r = await Promise.race([
      client.music
        .get(`${guildId}.playlists`)
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
      new Promise((res) => setTimeout(() => res({ ok: false, timeout: true }), 1500)),
    ]).catch(() => ({ ok: false }));
    // Una lectura FALLIDA nunca se cachea. Antes sí: un `{}`(cacheado 5s)
    // dejaba al panel sin stats de todas las canciones y por eso seguían
    // apareciendo y desapareciendo los numeros.
    if (!r?.ok) {
      if (c?.data) return c.data;
      return {};
    }
    const data = r.v && typeof r.v === "object" ? r.v : {};
    _playlistsCache.set(guildId, { at: Date.now(), data });
    return data;
  };
  client.invalidateQueueCaches = (guildId) => {
    if (guildId) { _playlistsCache.delete(guildId); client._musicMetaCache?.delete(guildId); }
    else { _playlistsCache.clear(); client._musicMetaCache?.clear(); }
    if (guildId && typeof guildId === "string") {
      for (const [kk] of _statsCache) if (kk.startsWith(guildId + "|")) _statsCache.delete(kk);
    } else if (!guildId) {
      _statsCache.clear();
    }
  };

  // Un solo repair a la vez por guild (updatequeue y updateplayer lo disparaban
  // en paralelo: el 2º leía ids viejos y volvía a "reparar" mensajes ya nuevos).
  client._panelRepair = client._panelRepair || new Map();

  // Apaga el AutoDJ por completo (usado por Stop / detener): borra los flags de
  // ON e intención (para que una cola nueva NO lo re-active solo), el previo, el
  // reporte y la fuente de la 🎲 junto con lo visto por usuario.
  client.autoDjDisable = (guildId) => {
    client.autoDj?.delete(guildId);
    client.autoDjIntent?.delete(guildId);
    client.autoDjPrev?.delete(guildId);
    client.autoDjReport?.delete(guildId);
    AutoDjSource.reset(client, guildId);
    client.logger.log(`[AutoDJ] Apagado (stop/detener) G:${guildId}`);
  };

  client._panelRepairT = client._panelRepairT || new Map();
  client.updateembed = async (client, guild) => {
    try {
      // Cooldown por guild: si Discord mantiene el pmsg marcado como inexistente,
      // un repair inmediato solo re-crea paneles en bucle (borrados que el usuario ve).
      // No volver a "reparar" durante unos segundos tras el último intento.
      const lastRepair = client._panelRepairT.get(guild.id) || 0;
      if (Date.now() - lastRepair < 4000) return;

      const pending = client._panelRepair.get(guild.id);
      if (pending) return await pending;

      const run = (async () => {
        // Se lee la data DENTRO del lock: si otro repair ya la actualizó, se ven los ids nuevos.
        const data = await client.music.get(`${guild.id}.music`);
        if (!data || !data.channel) return;

        const musicchannel = guild.channels.cache.get(data.channel) || await guild.channels.fetch(data.channel).catch(() => null);
        if (!musicchannel) return;

        const [playmsg, queuemsg] = await Promise.all([
          client.fetchPanelMessage(musicchannel, data.pmsg),
          client.fetchPanelMessage(musicchannel, data.qmsg),
        ]);

        // Error transitorio en alguno: no tocar nada.
        if (playmsg === undefined || queuemsg === undefined) return;

        // Self-Repair: SOLO si Discord confirmó que falta alguno.
        if (!playmsg || !queuemsg) {
          client._panelRepairT.set(guild.id, Date.now());
          client.logger.warn(
            `[Self-Repair] Missing messages in ${guild.name} (play:${!!playmsg} queue:${!!queuemsg}). ` +
            `Recreating ONLY the missing one. ` +
            `dbChannel=${data.channel} dbPmsg=${data.pmsg} dbQmsg=${data.qmsg}`
          );

          // NUNCA borrar un panel que sigue existiendo: se edita en su lugar.
          // Así "los mensajes que sigue habiendo" dejan de parpadear/borrarse.
          const keep = { playmsg, queuemsg };

          if (!keep.playmsg) {
            keep.playmsg = await musicchannel.send({
              embeds: [client.playembed(guild)],
              components: client.buttons(true),
            });
          } else {
            await keep.playmsg.edit({
              embeds: [client.playembed(guild)],
              components: client.buttons(true),
            }).catch(() => {});
          }

          if (!keep.queuemsg) {
            keep.queuemsg = await musicchannel.send({
              embeds: [client.queueembed(guild)],
            });
          } else {
            await keep.queuemsg.edit({ embeds: [client.queueembed(guild)] }).catch(() => {});
          }

          await client.music.set(`${guild.id}.music`, {
            channel: data.channel,
            pmsg: keep.playmsg?.id,
            qmsg: keep.queuemsg?.id,
          });
          return;
        }

        await Promise.all([
          playmsg.edit({
            embeds: [client.playembed(guild)],
            components: client.buttons(true),
          }).catch(() => {}),
          queuemsg.edit({ embeds: [client.queueembed(guild)] }).catch(() => {}),
        ]);
      })();

      client._panelRepair.set(guild.id, run);
      try { await run; } finally { client._panelRepair.delete(guild.id); }
    } catch (error) {
      console.error("Error updating embed:", error);
    }
  };

  // update queue
  /**
   *
   * @param {Queue} queue
   * @returns
   */
  client.updatequeueRaw = async (queue) => {
    try {
      const guildId = queue?.textChannel?.guildId || queue?.guildId;
      if (!guildId) return;
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return;

      const data = await client.music.get(`${guild.id}.music`);
      if (!data || !data.channel) return;

      const musicchannel = guild.channels.cache.get(data.channel) || await guild.channels.fetch(data.channel).catch(() => null);
      if (!musicchannel) return;

      let queueembed = await client.fetchPanelMessage(musicchannel, data.qmsg);
      if (queueembed === undefined) return; // fallo transitorio: no recrear

      // Self-Repair Trigger (solo si Discord confirmó que no existe)
      if (!queueembed) {
        return await client.updateembed(client, guild);
      }

      // Always get the freshest state from distube
      const freshQueue = client.distube.getQueue(guild.id) || queue;
      
      // If no queue, reset to empty
      if (!freshQueue || !freshQueue.songs.length) {
        client.queuePages?.delete(guild.id);
        client.autoDj?.delete(guild.id);
        client.autoDjPrev?.delete(guild.id);
        return await queueembed.edit({ embeds: [client.queueembed(guild)], components: [] }).catch(() => {});
      }

      let currentSong = freshQueue.songs[0];

      // El CURRENT TRACK debe reflejar lo que el VOICE emite de verdad
      // (actualPlaying viene de playSong), no lo que quedó en songs[0]: un
      // skip() en una transición colgada adelanta el índice interno de DisTube
      // sin colapsar songs[], y el refill del AutoDJ la reordena en caliente.
      const realNow = client.actualPlaying?.get(guild.id);
      if (realNow?.url && currentSong?.url && realNow.url !== currentSong.url) {
        const realObj = freshQueue.songs.find((s) => s?.url === realNow.url);
        if (realObj) {
          currentSong = realObj;
        } else {
          const uidTag = realNow.requestedBy
            ? (guild?.members?.cache?.get(realNow.requestedBy)?.user?.tag || `<@${realNow.requestedBy}>`)
            : null;
          currentSong = {
            ...currentSong,
            url: realNow.url,
            name: realNow.name,
            title: realNow.name,
            thumbnail: realNow.thumbnail,
            duration: realNow.duration,
            formattedDuration: realNow.formattedDuration || currentSong.formattedDuration,
            isLive: false,
            autoDj: realNow.autodj,
            _autoDj: realNow.autodj,
            uploader: { name: realNow.uploader || "😏" },
            user: { tag: uidTag || "Auto DJ", id: realNow.requestedBy || currentSong.user?.id || null },
          };
        }
      }

      const allPlaylists = await allPlaylistsWithCache(client, guild.id);

      const currentStats = currentSong?.url ? await statsWithCache(client, guildId, currentSong.url, allPlaylists, guild) : EMPTY_STATS;
      const currentStatsParts = [];
      if (currentStats.likes > 0) currentStatsParts.push(`👍${currentStats.likes}`);
      if (currentStats.dislikes > 0) currentStatsParts.push(`👎${currentStats.dislikes}`);
      if (currentStats.plays > 0) currentStatsParts.push(`🔥${currentStats.plays}`);
      const currentStatsText = currentStatsParts.length > 0 ? ` | ${currentStatsParts.join(" ")}` : "";
      // A quién le gusta la canción actual (tiene el video en sus Favoritas).
      const currentOwners = (currentStats.owners || []).slice(0, 3).join(", ");
      // Para canciones del bot, SOLO el nombre de la persona usada para
      // recomendar (si el patrón fue "de cualquiera", la 1ra dueña del tema);
      // nada de listas largas ni "Recomendación de ...".
      const currentIsAutoDj = !!(currentSong?.autoDj || currentSong?._autoDj);
      const currentOwnersText =
        currentIsAutoDj || !currentOwners ? "" : ` | 👤 ${currentOwners}`;
      const currentRecName =
        (currentSong?.autoDjUserId &&
          guild?.members?.cache?.get(currentSong.autoDjUserId)?.user?.tag) ||
        (currentOwners ? currentOwners.split(",")[0].trim() : null);
      const currentReq =
        currentIsAutoDj
          ? (currentSong?.autoDjType === "rec"
              ? `🛸 ${currentRecName || "Recomendación"}`
              : "🎲 Aleatoria")
          : (currentSong?.user?.tag || "Auto DJ");

      const storedLimit = await client.music.get(`${guild.id}.qlimit`).catch(() => undefined);
      const maxTracks = Number.isInteger(storedLimit) && storedLimit >= 1 && storedLimit <= 50 ? storedLimit : 10;

      const totalUpNext = Math.min(freshQueue.songs.length - 1, maxTracks);
      const totalPages = Math.max(1, Math.ceil(totalUpNext / client.QUEUE_PER_PAGE));

      if (!client.queuePages) client.queuePages = new Map();
      let page = Number.isInteger(client.queuePages.get(guild.id)) ? client.queuePages.get(guild.id) : 0;
      page = Math.min(Math.max(0, page), totalPages - 1);
      client.queuePages.set(guild.id, page);

      const from = 1 + page * client.QUEUE_PER_PAGE;
      const upNextTracks = freshQueue.songs.slice(from, from + client.QUEUE_PER_PAGE);
      const upNextStats = await Promise.all(upNextTracks.map((track) =>
        track.url ? statsWithCache(client, guildId, track.url, allPlaylists, guild) : Promise.resolve({ likes: 0, dislikes: 0, plays: 0 })
      ));
      // Rótulo para canciones puestas por el AutoDJ: SOLO el nombre de la persona
      // usada para recomendar (para "rec"), o 🎲 Aleatoria. Nada de listas largas.
      const autodjLabel = (track, firstOwner) => {
        if (!track || (!track.autoDj && !track._autoDj)) return null;
        if (track.autoDjType === "rec") {
          const uid = track.autoDjUserId;
          const name = uid
            ? (guild?.members?.cache?.get(uid)?.user?.tag || track.user?.nickname || null)
            : (firstOwner || null);
          return name ? `🛸 ${name}` : "🛸 Recomendación";
        }
        return "🎲 Aleatoria";
      };

      let queueString = "";
      upNextTracks.forEach((track, i) => {
        const index = from + i;
        const tStats = upNextStats[i] || { likes: 0, dislikes: 0, plays: 0 };
        const tStatsParts = [];
        if (tStats.likes > 0) tStatsParts.push(`👍${tStats.likes}`);
        if (tStats.dislikes > 0) tStatsParts.push(`👎${tStats.dislikes}`);
        if (tStats.plays > 0) tStatsParts.push(`🔥${tStats.plays}`);
        const tStatsStr = tStatsParts.length > 0 ? ` | ${tStatsParts.join(" ")}` : "";
        // A la derecha (solo canciones tuyas): quién la pidió/le gusta. Las del
        // bot (autoDj) ya llevan su rótulo arriba, nada de listas largas.
        const tIsAutoDj = !!(track?.autoDj || track?._autoDj);
        const tOwners = (tStats.owners || []).slice(0, 3).join(", ");
        const tOwnersStr = tIsAutoDj || !tOwners ? "" : ` | 👤 ${tOwners}`;
        const tReq = autodjLabel(track, (tStats.owners || [])[0]) || track.user?.tag || "Auto DJ";
        queueString += `\`${index}.\` **${client.getTitle(track)}** - ${
          track.isLive ? "LIVE STREAM" : track.formattedDuration.split(" | ")[0]
        } - \`${tReq}\`${tStatsStr}${tOwnersStr}\n`;
      });

      const newQueueEmbed = new EmbedBuilder()
        .setColor(client.config.embed.color)
        .setAuthor({
          name: `Music Queue - [${freshQueue.songs.length} Tracks]`,
          iconURL: guild.iconURL({ dynamic: true }),
        })
        .setFooter({
          text: totalUpNext > 0 ? `Página ${page + 1}/${totalPages} · ${totalUpNext} canciones próximas` : `Página ${page + 1}/${totalPages} · Sin cola`,
        })
        .addFields([
          {
            name: `**\`0.\` __CURRENT TRACK__**`,
            value: `**${client.getTitle(currentSong)}** - ${
              currentSong?.isLive
                ? "LIVE STREAM"
                : currentSong?.formattedDuration.split(" | ")[0]
            } - \`${currentReq}\`${currentStatsText}${currentOwnersText}`,
          },
        ]);

      if (queueString.length > 0) {
        newQueueEmbed.setDescription(queueString.substring(0, 2048));
      } else {
        newQueueEmbed.setDescription("No more songs in queue.");
      }

      let components = [];
      if (totalPages > 1) {
        const navRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("queue_page_first").setEmoji("⏮").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId("queue_page_prev").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId("queue_page_next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1),
          new ButtonBuilder().setCustomId("queue_page_last").setEmoji("⏭").setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)
        );
        components = [navRow];
      }

      await queueembed.edit({ embeds: [newQueueEmbed], components }).catch(() => {});
    } catch (error) {
      console.error("Error updating queue:", error);
    }
  };

  // update player
  /**
   *
   * @param {Queue} queue
   * @param {Object} songOverride - canción REAL que suena (por si songs[0] quedó desfasado por un skip en idle)
   * @returns
   */
  client.updateplayerRaw = async (queue, songOverride) => {
    try {
      const guildId = queue?.textChannel?.guildId || queue?.guildId;
      if (!guildId) return;
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return;

      const data = await client.music.get(`${guild.id}.music`);
      if (!data || !data.channel) return;

      const musicchannel = guild.channels.cache.get(data.channel) || await guild.channels.fetch(data.channel).catch(() => null);
      if (!musicchannel) return;

      let playembed = await client.fetchPanelMessage(musicchannel, data.pmsg);
      if (playembed === undefined) return; // fallo transitorio: no recrear

      // Self-Repair Trigger (solo si Discord confirmó que no existe)
      if (!playembed) {
        return await client.updateembed(client, guild);
      }

      // Always get the freshest state from distube
      const freshQueue = client.distube.getQueue(guild.id);
      if (!freshQueue || !freshQueue.songs.length) {
        return await playembed.edit({
          embeds: [client.playembed(guild)],
          components: client.buttons(true),
        }).catch(() => {});
      }

      // Si nos pasan el track real (p.ej. el emitido por playSong), confiar en él;
      // si no, usar songs[0]. songs[0] puede quedar desfasado si un skip() se
      // ejecutó durante una transición y DisTube no colapsó la cola.
      let track = (songOverride && songOverride.name) ? songOverride : freshQueue.songs[0];
      if (!(songOverride && songOverride.name)) {
        // La VERDAD de lo que suena es el playSong (actualPlaying), aunque la
        // canción ya no esté en songs[] (skip en transición colgada / el refill
        // del AutoDJ la movió). Antes se exigía encontrarla en la cola y, si no
        // estaba, se mostraba songs[0] (que puede ser una "fantasma" ya
        // reproducida → panel 2-3 canciones desfasado).
        const actual = client.actualPlaying?.get(guildId);
        if (actual && actual.url && track?.url && actual.url !== track.url) {
          const found = freshQueue.songs.find((s) => s?.url === actual.url);
          if (found) {
            track = found;
          } else {
            track = {
              ...track,
              url: actual.url,
              name: actual.name || actual.url,
              title: actual.name || actual.url,
              thumbnail: actual.thumbnail || null,
              duration: actual.duration || 0,
              formattedDuration: actual.formattedDuration || track.formattedDuration,
              uploader: { name: actual.uploader || "😏" },
            };
          }
        }
      }
      if (!track || !track.name) return;

      // RENDER INMEDIATO: la canción actual es lo importante al empezar. Las
      // stats (lectura a Mongo) se aplican DESPUÉS en segundo plano; si Mongo
      // se demora, el embed fijo igual ya muestra la canción que suena.
      const rawStats = "Sin stats aún";
      const buildEmbed = (statsValue) =>
        new EmbedBuilder()
          .setColor(client.config.embed.color)
          .setImage(track?.thumbnail || null)
          .setTitle(client.getTitle(track))
          .setURL(track?.url)
          .addFields(
            {
              name: "**Requested By**",
              value: `\`${track.user?.tag || "Unknown"}\``,
              inline: true,
            },
            {
              name: "**Author**",
              value: `\`${track.uploader?.name || "😏"}\``,
              inline: true,
            },
            {
              name: "**Duration**",
              value: `\`${track.formattedDuration}\``,
              inline: true,
            },
            {
              name: "**Stats**",
              value: `\`${statsValue}\``,
              inline: true,
            }
          )
          .setFooter(client.getFooter(track.user || client.user));
      const buildStatsText = (stats) => {
        const parts = [];
        if (stats.likes > 0) parts.push(`👍${stats.likes}`);
        if (stats.dislikes > 0) parts.push(`👎${stats.dislikes}`);
        if (stats.plays > 0) parts.push(`🔥${stats.plays}`);
        const likes = (stats.likedBy || []).length ? `\n👍 Likes: ${stats.likedBy.join(", ")}` : "";
        const dislikes = (stats.dislikedBy || []).length ? `\n👎 Dislikes: ${stats.dislikedBy.join(", ")}` : "";
        return parts.length || likes || dislikes ? `${parts.join(" · ")}${likes}${dislikes}` : rawStats;
      };

      // Estado del panel por guild: evita el "parpadeo" entre "Sin stats aún" y
      // los stats reales cuando varios updateplayer/updatequeue corren a la vez
      // (cada uno re-edita). Reglas:
      //   * si ya se muestra esta canción con este texto → no re-edito
      //   * si ya se muestra esta canción CON stats reales → no la bajo a
      //     "Sin stats aún" (nunca información falsa hacia atrás)
      if (!client._playerPanel) client._playerPanel = new Map();
      // Firma del estado visual de los botones: si cambia (p.ej. toggle de Auto
      // DJ, loop, autoplay, pausa) hay que re-editar el panel aunque el texto de
      // stats sea el mismo (el dedup del parpadeo no debe congelar el botón).
      const buttonsStateKey = () => {
        const gid = freshQueue?.textChannel?.guildId || freshQueue?.guildId;
        return `${!!client.autoDj?.get(gid)}|${Number(freshQueue?.repeatMode || 0)}|${!!freshQueue?.autoplay}|${!!freshQueue?.paused}|${freshQueue?.songs?.length || 0}`;
      };
      const applyPanel = async (candidateText, useButtons) => {
        const cur = client._playerPanel.get(guildId);
        const btnKey = buttonsStateKey();
        if (cur && cur.url === track.url && cur.text === candidateText && cur.btn === btnKey) return;
        // NUNCA degradar una canción que ya muestra stats reales a "Sin stats
        // aún", aunque cambie el estado de los botones (btnKey): el btn solo
        // decide si re-pintar con el MISMO texto, no si borrar stats.
        if (candidateText === rawStats && cur && cur.url === track.url && cur.text !== rawStats) return;
        await playembed.edit({
          embeds: [buildEmbed(candidateText)],
          components: client.buttons(useButtons, freshQueue),
        }).catch(() => {});
        client._playerPanel.set(guildId, { url: track.url, text: candidateText, btn: btnKey });
      };

// Stats ANTES de pintar, en una SOLA pasada.
      //
      // Antes se pintaba primero "Sin stats aún" y las stats se inyectaban
      // después con una segunda edición: eso es literalmente el parpadeo que se
      // veía (cada canción salía "Sin stats aún" y un instante después cambiaba
      // a "👍2 🔥5"). La lectura se midió contra el store real y tarda ~95ms
      // (get playlists ~80ms + stats ~14ms), imperceptible: no hay motivo para
      // pagar el parpadeo a cambio de un pintado "rápido".
      // El tope de 1200ms es la red de seguridad para que, si el store se
      // cuelga, el panel se actualice igual en vez de quedarse congelado.
      let firstText = rawStats;
      try {
        const allPlaylists = await allPlaylistsWithCache(client, guildId);
        const pendiente = track.url
          ? statsWithCache(client, guildId, track.url, allPlaylists, guild)
          : Promise.resolve(EMPTY_STATS);
        const stats = await Promise.race([
          pendiente,
          new Promise((r) => setTimeout(() => r(null), 1200)),
        ]);
        if (stats) firstText = buildStatsText(stats);
      } catch {}

      await applyPanel(firstText, false);
    } catch (error) {
      console.error("Error updating player:", error);
    }
  };

  // Coalescing "latest-wins" para los renders del panel (updateplayer /
  // updatequeue). Cada playSong + addSong + refill del AutoDJ dispara una
  // actualización con awaits lentos (DB, fetch, stats); en una ráfaga (p.ej.
  // encolando muchas canciones) corren decenas en paralelo, sus edits llegan a
  // Discord FUERA DE ORDEN y el embed "se congela" mostrando una canción vieja.
  // Este wrapper serializa por guild: solo UNA llamada activa a la vez y, si
  // llegan nuevas mientras corre, queda pendiente SOLO la MÁS NUEVA (se ejecuta
  // al terminar la actual). Así el embed siempre pinta lo más fresco y nunca se
  // amontonan edits.
  const panelCoalesce = (fn) => {
    // Mapas PROPIOS por wrapper: updateplayer y updatequeue NO comparten estado
    // (si lo compartieran, un pending de uno lo ejecutaría la función del otro y
    // el mensaje correspondiente quedaría congelado).
    const busy = new Map();
    const pending = new Map();
    // Tope de seguridad: si una edición se cuelga (p.ej. un fetch de Discord que
    // no responde), igual se libera el lock para no bloquear TODAS las futuras
    // actualizaciones de ese guild.
    const guard = (p) => Promise.race([
      Promise.resolve(p).catch(() => {}),
      new Promise((r) => setTimeout(r, 20000)),
    ]);
    return async (...args) => {
      const guildId = args[0]?.textChannel?.guildId || args[0]?.guildId;
      if (!guildId) return;
      if (busy.get(guildId)) {
        pending.set(guildId, args);
        return;
      }
      busy.set(guildId, true);
      try {
        while (pending.has(guildId)) {
          const latest = pending.get(guildId);
          pending.delete(guildId);
          await guard(fn(...latest));
        }
        await guard(fn(...args));
      } finally {
        busy.delete(guildId);
      }
    };
  };
  client.updatequeue = panelCoalesce(client.updatequeueRaw);
  client.updateplayer = panelCoalesce(client.updateplayerRaw);

  /**
   *
   * @param {Guild} guild
   * @returns
   */
  client.joinVoiceChannel = async (guild) => {
    try {
      const db = await client.music?.get(`${guild.id}.vc`);
      if (!db || !db.enable) return;

      if (!guild.members.me.permissions.has(PermissionFlagsBits.Connect))
        return;

      const voiceChannel = guild.channels.cache.get(db.channel);
      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) return;

      // Join the voice channel immediately
      await client.distube.voices.join(voiceChannel);
    } catch (error) {
      console.error("Error joining voice channel:", error);
    }
  };

  /**
   *
   * @param {CommandInteraction} interaction
   */
  client.handleHelpSystem = async (interaction) => {
    const send = interaction?.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);

    const user = interaction.member.user;
    const commands = interaction?.user ? client.commands : client.mcommands;
    const categories = interaction?.user
      ? client.scategories
      : client.mcategories;

  const emoji = { Information: "🔰", Music: "🎵", Settings: "⚙️", Playlist: "📂" };

    const allcommands = client.mcommands.size;
    const allguilds = client.guilds.cache.size;
    const botuptime = `<t:${Math.floor(
      Date.now() / 1000 - client.uptime / 1000
    )}:R>`;
    const buttons = [
      new ButtonBuilder()
        .setCustomId("home")
        .setStyle(ButtonStyle.Success)
        .setEmoji("🏘️")
        .setLabel("Home"),
      ...categories.map((cat) => {
        const btn = new ButtonBuilder()
          .setCustomId(cat)
          .setStyle(ButtonStyle.Secondary)
          .setLabel(cat);
        const em = emoji[cat];
        if (em) btn.setEmoji(em);
        return btn;
      }),
    ];
    const row = new ActionRowBuilder().addComponents(buttons);

    const help_embed = new EmbedBuilder()
      .setColor(client.config.embed.color)
      .setAuthor({
        name: client.user.tag,
        iconURL: client.user.displayAvatarURL({ dynamic: true }),
      })
      .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
      .setDescription(
        `**An advanced Music System with Audio Filtering A unique Music Request System and much more!**`
      )
      .addFields([
        {
          name: `Stats`,
          value: `>>> **:gear: \`${allcommands}\` Commands\n:file_folder: \`${allguilds}\` Guilds\n⌚️ ${botuptime} Uptime\n🏓 \`${client.ws.ping}\` Ping**`,
        },
      ])
      .setFooter(client.getFooter(user));

    const main_msg = await send({
      embeds: [help_embed],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });

    const filter = async (i) => {
      return true;
    };

    const colector = main_msg.createMessageComponentCollector({ filter });

    colector.on("collect", async (i) => {
      if (i.isButton()) {
        await i.deferUpdate().catch(() => {});
        const directory = i.customId;
        if (directory == "home")
          main_msg.edit({ embeds: [help_embed] }).catch(() => {});
        else {
          main_msg
            .edit({
              embeds: [
                new EmbedBuilder()
                  .setColor(client.config.embed.color)
                  .setTitle(
                    `${emoji[directory] || "📁"} ${directory} Commands ${
                      emoji[directory] || ""
                    }`
                  )
                  .setDescription(
                    `>>> ${commands
                      .filter((cmd) => cmd.category === directory)
                      .map((cmd) => `\`${cmd.name}\``)
                      .join(",  ")}`
                  )
                  .setThumbnail(client.user.displayAvatarURL())
                  .setFooter(client.getFooter(user)),
              ],
            })
            .catch(() => {});
        }
      }
    });

    colector.on("end", async () => {
      row.components.forEach((c) => c.setDisabled(true));
      main_msg.edit({ components: [row] }).catch(() => {});
    });
  };

  /**
   *
   * @param {CommandInteraction} interaction
   */
  client.HelpCommand = async (interaction) => {
    const send = interaction?.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);
    const user = interaction.member.user;
    // for commands
    const commands = interaction?.user ? client.commands : client.mcommands;
    // for categories
    const categories = interaction?.user
      ? client.scategories
      : client.mcategories;

    const emoji = {
      Information: "🔰",
      Music: "🎵",
      Settings: "⚙️",
      Playlist: "📂",
    };

    let allCommands = categories.map((cat) => {
      let cmds = commands
        .filter((cmd) => cmd.category == cat)
        .map((cmd) => `\`${cmd.name}\``)
        .join(" ' ");

      return {
        name: `${emoji[cat]} ${cat}`,
        value: cmds,
      };
    });

    let help_embed = new EmbedBuilder()
      .setColor(client.config.embed.color)
      .setAuthor({
        name: `My Commands`,
        iconURL: client.user.displayAvatarURL({ dynamic: true }),
      })
      .addFields(allCommands)
      .setFooter(client.getFooter(user));

    send({
      embeds: [help_embed],
    });
  };

  /**
   *
   * @param {Song} song
   * @returns {string}
   */
  client.getTitle = (song) => {
    try {
      if (!song) return "Unknown Track";
      const TrackTitle = (song.name || song.playlist?.name || "").trim();
      if (!TrackTitle) return "Unknown Track";

      const title = TrackTitle.replace(/[\[\(][^\]\)]*[\]\)]/, "").trim();

      const parts = title.split("|");

      const shortTitle = parts[0].trim() || "Unknown Track";

      return shortTitle.substring(0, 25);
    } catch (error) {
      console.error("Error while processing track title:", error);
      return "Unknown Track";
    }
  };
};