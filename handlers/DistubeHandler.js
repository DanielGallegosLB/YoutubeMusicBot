const { EmbedBuilder, Events, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require("discord.js");
const MusicBot = require("./Client");
const DashboardFeed = require("./DashboardFeed");
const Store = require("./PlaylistStore");
const UserHistory = require("./UserHistory");
const { check_dj, skip, recordSkipSignal } = require("./functions");
const { streamPlaylist, shufflePlay } = require("./PlaylistLoader");
const { fetchPlaylistAllURLsFlat } = require("./PlaylistFetcher");
const { stopMarqueeActivity } = require("./ActivityManager");

function logStream(client, guildId, msg) {
  const ts = new Date().toLocaleTimeString("es-ES", { hour12: false });
  console.log(`[PlaylistLoader][${ts}] G:${guildId} ${msg}`);
}

// Clave canónica de una URL (el 🚫 se compara con KEY canónica: mismo video
// aunque el pool traiga la variante con &list de la lista original).
const canonUrlKey = (u) => {
  if (typeof u !== "string" || !u) return u;
  try {
    const nu = new URL(u.trim());
    if (/youtube\.com|youtu\.be/i.test(nu.host || "")) {
      const v = nu.searchParams.get("v");
      if (v) return `yt:${v}`;
      if (nu.pathname.startsWith("/shorts/")) return `yt:${nu.pathname.split("/")[2] || u}`;
    }
  } catch {}
  return u.trim();
};

/**
 *
 * @param {MusicBot} client
 */
module.exports = async (client) => {
  // interaction handling
  try {
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.guild || interaction.user.bot) return;
      if (interaction.isButton()) {
        const { customId, member } = interaction;

        // La canción VÁLIDA para 👍/👎/⭐: la que DisTube está emitiendo de VERDAD.
        // El AutoDJ y el reorden tocan queue.songs a mano; si songs[0] quedó
        // desfasado, apuntarle daría like a la canción equivocada (o a "cola
        // vacía"). client.actualPlaying guarda lo que suena de verdad.
        const currentTrackForLike = () => {
          const q = client.distube.getQueue(interaction.guildId);
          const first = q?.songs?.[0];
          const real = client.actualPlaying?.get?.(interaction.guildId);
          if (real?.url && first?.url && real.url !== first.url) {
            return {
              url: real.url,
              name: real.name || first.name || "Sin título",
              duration: real.duration || 0,
              formattedDuration: real.formattedDuration || first.formattedDuration || null,
              thumbnail: real.thumbnail || first.thumbnail || null,
              uploader: real.uploader ? { name: real.uploader } : first.uploader,
              user: real.requestedBy ? { id: real.requestedBy } : first.user,
            };
          }
          return first || null;
        };

        // Handle "No sugerir" button
        if (customId.startsWith("no_suggest_")) {
          const userId = customId.replace("no_suggest_", "");
          if (member.id !== userId) {
            return interaction.reply({ content: "Este botón no es para ti.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
          await UserHistory.setNoSuggestions(client, interaction.guildId, userId, true);
          return interaction.reply({ content: "✅ No recibirás más sugerencias al conectar.", flags: MessageFlags.Ephemeral }).then((m) => client.scheduleDelete(m, interaction)).catch(() => {});
        }

        // Handle "Reproducir Favoritos" button
        if (customId === "suggest_favorites") {
          await interaction.deferUpdate().catch(() => {});
          const channel = interaction.member.voice.channel;
          if (!channel) {
            return interaction.followUp({ content: "❌ Debes unirte a un canal de voz.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
          try {
            // Get all users in the voice channel
            const members = channel.members.filter((m) => !m.user.bot).map((m) => m.id);
            const excludes = await Store.getAutodjExcludes(client, interaction.guildId).catch(() => ({}));
            // SOLO favoritas reales (con 👍 o guardadas a mano con ⭐), intercaladas
            // entre los oyentes. Antes se usaba la lista entera, que tenía ~500
            // canciones por usuario que una versión vieja del bot guardaba sola.
            const favs = await Store.getInterleavedFavorites(client, interaction.guildId, members, excludes);
            if (!favs || favs.length === 0) {
              return interaction.followUp({
                content: "❌ No hay canciones con like ni guardadas con ⭐. Dale 👍 o ⭐ a las que quieras que el bot ponga.",
                flags: MessageFlags.Ephemeral,
              }).catch(() => {});
            }

            if (!favs || favs.length === 0) {
              return interaction.followUp({
                content: "❌ No hay canciones con like ni guardadas con ⭐. Dale 👍 o ⭐ a las que quieras para que el bot las ponga.",
                flags: MessageFlags.Ephemeral,
              }).catch(() => {});
            }
            const playOpts = {
              member: interaction.member,
              textChannel: interaction.channel,
              selfDeaf: true,
            };
            for (const track of favs) {
              if (track.url) {
                await client.distube.play(channel, track.url, playOpts).catch(() => {});
              }
            }
            const label = members.length > 1
              ? `✅ Reproduciendo ${favs.length} favoritos intercalados (${members.length} usuarios).`
              : `✅ Reproduciendo ${favs.length} canciones de tus favoritos.`;
            return interaction.followUp({ content: label, flags: MessageFlags.Ephemeral }).then((m) => client.scheduleDelete(m, interaction)).catch(() => {});
          } catch (e) {
            return interaction.followUp({ content: "❌ Error al reproducir favoritos.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
        }

        // Handle favorites management buttons
        if (customId.startsWith("fav_nav_")) {
          if (!client.favPages) client.favPages = new Map();
          const current = client.favPages.get(interaction.message.id) || 0;
          let page = current;
          if (customId === "fav_nav_first") page = 0;
          else if (customId === "fav_nav_prev") page = Math.max(0, current - 1);
          else if (customId === "fav_nav_next") page = current + 1;
          else if (customId === "fav_nav_last") {
            const favs = await Store.sortFavorites(client, interaction.guildId, interaction.user.id);
            page = Math.max(0, Math.ceil(favs.length / UserHistory.FAVORITES_PER_PAGE) - 1);
          }
          else return interaction.deferUpdate().catch(() => {});
          client.favPages.set(interaction.message.id, page);
          await interaction.deferUpdate().catch(() => {});
          const embed = await UserHistory.buildFavoritesEmbed(client, interaction.guildId, interaction.user.id, page);
          const components = await UserHistory.buildFavoritesComponents(client, interaction.guildId, interaction.user.id, page);
          if (embed) return interaction.editReply({ embeds: [embed], components }).catch(() => {});
          return;
        }

        if (customId === "fav_nav_info") return interaction.deferUpdate().catch(() => {});

        if (customId === "fav_remove") {
          if (!client.favRemoveMsg) client.favRemoveMsg = new Map();
          client.favRemoveMsg.set(interaction.user.id, interaction.message.id);
          const modal = new ModalBuilder()
            .setCustomId("fav_remove_modal")
            .setTitle("Eliminar canciones favoritas");
          const input = new TextInputBuilder()
            .setCustomId("fav_remove_indices")
            .setLabel("Número(s) o rango(s) a eliminar")
            .setPlaceholder("Ej: 5-20, 30, 40-50")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(500);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal).catch(() => {});
        }

        if (customId === "fav_clear_all") {
          await interaction.deferUpdate().catch(() => {});
          const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("fav_clear_all_confirm")
              .setLabel("Sí, borrar todas")
              .setEmoji("✅")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId("fav_cancel")
              .setLabel("Cancelar")
              .setEmoji("❌")
              .setStyle(ButtonStyle.Secondary)
          );
          return interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor("#FF0000")
              .setDescription("⚠️ Esto eliminará **TODAS** las canciones favoritas.\n¿Estás seguro?")],
            components: [confirmRow]
          }).catch(() => {});
        }

        if (customId === "fav_clear_all_confirm") {
          await interaction.deferUpdate().catch(() => {});
          const removed = await Store.clearAll(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
          client.favPages?.delete(interaction.message.id);
          if (removed === 0) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(client.config.embed.color).setDescription("No había canciones para eliminar.")], components: [] }).catch(() => {});
          return interaction.editReply({
            embeds: [new EmbedBuilder().setColor("#00FF00").setDescription(`✅ Se eliminaron todas las ${removed} canciones favoritas.`)],
            components: []
          }).catch(() => {});
        }

        if (customId === "fav_cancel") {
          await interaction.deferUpdate().catch(() => {});
          const currentPage = client.favPages?.get(interaction.message.id) || 0;
          const embed = await UserHistory.buildFavoritesEmbed(client, interaction.guildId, interaction.user.id, currentPage);
          const components = await UserHistory.buildFavoritesComponents(client, interaction.guildId, interaction.user.id, currentPage);
          if (embed) return interaction.editReply({ embeds: [embed], components }).catch(() => {});
          return interaction.editReply({ embeds: [], components: [] }).catch(() => {});
        }

        if (customId === "player_like") {
          const t0 = Date.now();
          try {
            const _queue = client.distube.getQueue(interaction.guildId);
            const _track = currentTrackForLike();
            if (!_track || !_queue) {
              client.logger.warn(`[Like] sin cola/cancion para ${interaction.user.tag}: no se pudo registrar`);
              return interaction.reply({ content: "❌ No hay nada sonando ahora.", flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await Store.create(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
            const existing = await Store.get(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
            const trackExists = existing?.tracks?.some((t) => Store.canonUrlKey(t.url) === Store.canonUrlKey(_track.url));
            if (!trackExists) {
              const serialized = Store.serializeSong(_track, interaction.user);
              await Store.addTracks(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", [serialized]);
            }
            // Sin tope por reproducción: cada 👍 SUMA (el contador se acumula por
            // usuario en la DB), igual que el like manual del dashboard.
            const result = await Store.likeTrackByUrl(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", _track.url);
            if (!result) {
              client.logger.warn(`[Like] likeTrackByUrl devolvio null para "${_track.name}"`);
              return interaction.editReply({ content: "❌ Error al procesar." }).catch(() => {});
            }
            client.logger.log(`[Like] 👍 ${interaction.user.tag} dio like a "${_track.name}" (G:${interaction.guildId}) → total ${result.likeCount}👍 ${result.dislikeCount}👎 (${Date.now() - t0}ms)`);
            const vLike = await Store.verifyLike(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", _track.url).catch(() => null);
            if (vLike) client.logger.log(`[Like] ${interaction.user.tag} check "${_track.name}": fav.likedBy=${vLike.favLikes} fav.dislikedBy=${vLike.favDislikes} gStat.likedBy=${vLike.gStatLikes} gStat.dislikedBy=${vLike.gStatDislikes}`);
            Store.sortFavorites(client, interaction.guildId, interaction.user.id).catch(() => {});
            // El like ya se guardó en la DB; invalidar la caché de stats (20s)
            // para que el embed fijo muestre el 👍 al instante.
            client.invalidateQueueCaches?.(interaction.guildId);
            client.updatequeue(_queue).catch(() => {});
            client.updateplayer(_queue).catch(() => {});
            const msg = `👍 Like! (${result.score >= 0 ? "+" : ""}${result.score} pts · ${result.likeCount}👍 ${result.dislikeCount}👎)`;
            return interaction.editReply({ content: msg }).catch(() => {});
          } catch (e) {
            // Antes este bloque no tenía catch: cualquier fallo se comía en
            // silencio y el usuario solo veía "interacción fallida".
            client.logger.error(`[Like] ERROR de ${interaction.user.tag} en "${_track?.name || "?"}": ${e?.message || e}`);
            if (e?.stack) client.logger.error(e.stack.split("\n").slice(1, 4).join("\n"));
            return interaction.editReply({ content: "❌ Error al guardar el like." }).catch(() => {});
          }
        }

        if (customId === "player_dislike") {
          const _queue = client.distube.getQueue(interaction.guildId);
          const _track = currentTrackForLike();
          if (!_track || !_queue) return interaction.deferUpdate().catch(() => {});
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
          await Store.create(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
          const existing = await Store.get(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
          const trackExists = existing?.tracks?.some((t) => Store.canonUrlKey(t.url) === Store.canonUrlKey(_track.url));
          if (!trackExists) {
            const serialized = Store.serializeSong(_track, interaction.user);
            await Store.addTracks(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", [serialized]);
          }
          // Sin tope por reproducción: cada 👎 SUMA (se acumula por usuario).
          const result = await Store.dislikeTrackByUrl(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", _track.url);
          if (!result) return interaction.editReply({ content: "❌ Error al procesar." }).catch(() => {});
          client.logger.log(`[Like] 👎 ${interaction.user.tag} dio dislike a "${_track.name}" (G:${interaction.guildId}) → total ${result.likeCount}👍 ${result.dislikeCount}👎`);
          const vDislike = await Store.verifyLike(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", _track.url).catch(() => null);
          if (vDislike) client.logger.log(`[Like] ${interaction.user.tag} check "${_track.name}": fav.likedBy=${vDislike.favLikes} fav.dislikedBy=${vDislike.favDislikes} gStat.likedBy=${vDislike.gStatLikes} gStat.dislikedBy=${vDislike.gStatDislikes}`);
          Store.sortFavorites(client, interaction.guildId, interaction.user.id).catch(() => {});
          client.invalidateQueueCaches?.(interaction.guildId);
          client.updatequeue(_queue).catch(() => {});
          client.updateplayer(_queue).catch(() => {});
          return interaction.editReply({ content: `👎 Dislike! (${result.score >= 0 ? "+" : ""}${result.score} pts · ${result.likeCount}👍 ${result.dislikeCount}👎)` }).catch(() => {});
        }

        if (customId === "favorite_btn") {
          const _queue = client.distube.getQueue(interaction.guildId);
          const _track = currentTrackForLike();
          if (!_track || !_queue) return interaction.deferUpdate().catch(() => {});
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
          await Store.create(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
          const existing = await Store.get(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
          const isFavorited = existing?.tracks?.some((t) => Store.canonUrlKey(t.url) === Store.canonUrlKey(_track.url));
          if (isFavorited) {
            return interaction.editReply({ content: "⭐ Ya tenías esta canción en tus favoritas." }).catch(() => {});
          }
          const serialized = Store.serializeSong(_track, interaction.user);
          // `manual: true` = la guardó el usuario a conscience con ⭐, NO el
          // guardado automático de una versión vieja. El AutoDJ solo usa
          // favoritas reales (con 👍 o ⭐ manual), así que esto cuenta.
          serialized.manual = true;
          serialized.manualAt = Date.now();
          const added = await Store.addTracks(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", [serialized]);
          Store.sortFavorites(client, interaction.guildId, interaction.user.id).catch(() => {});
          client.invalidateQueueCaches?.(interaction.guildId);
          client.updatequeue(_queue).catch(() => {});
          client.updateplayer(_queue).catch(() => {});
          const reply = added > 0
            ? "⭐ ¡Cancion guardada en tus favoritas!"
            : "⭐ Ya tenías esta canción en tus favoritas.";
          return interaction.editReply({ content: reply }).catch(() => {});
        }

        // Botón "🚫 No AutoDJ": salta la canción actual y la excluye para
        // este usuario, de modo que el AutoDJ no vuelva a elegirla para él.
        if (customId === "autodj_skipban") {
          const _queue = client.distube.getQueue(interaction.guildId);
          const _channel = interaction.member.voice.channel;
          if (!_channel) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
            return interaction.editReply({ content: "❌ Debes unirte a un canal de voz.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
          // Apuntar a la canción que suena DE VERDAD (no a songs[0], que puede
          // quedar desfasado): si no, el ban va al URL equivocado y el tema
          // vuelve a recomendarse.
          const current = currentTrackForLike() || _queue?.songs?.[0];
          if (!_queue || !current?.url) {
            return interaction.editReply({ content: "❌ No hay una canción sonando ahora.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
          try {
            // Loguear ANTES de actuar: queremos ver el intento y con qué datos.
            const canon = canonUrlKey(current.url);
            client.logger.log(
              `[AutoDjBan] 🚫 ${interaction.user.tag} (G:${interaction.guildId}) banea "${current.name || current.url}" ` +
              `url=${current.url} canon=${canon} seenSession=${_queue._autoDjExcludedSession instanceof Set ? _queue._autoDjExcludedSession.size : 0}`
            );
            await Store.addAutodjExclude(client, interaction.guildId, interaction.user.id, current.url);
            // Esta sesión tampoco la vuelve a elegir mientras dure la cola.
            // _autoDjExcludedSession es un Set dedicado a los 🚫 de ESTA sesión:
            // a diferencia de _autoDjSeen (que pickUnseen recicla y puede volver
            // a elegir), esto se suma a las exclusiones persistentes en el refill.
            // Se guarda la CLAVE CANÓNICA para tapar la variante con &list de la
            // que pueda venir la recomendación (ej. "Psalm 135" de otra lista).
            if (!_queue._autoDjExcludedSession) _queue._autoDjExcludedSession = new Set();
            _queue._autoDjExcludedSession.add(canon);
            _queue._autoDjExcludedSession.add(current.url);
            if (_queue._autoDjSeen instanceof Map) _queue._autoDjSeen.set(current.url, Date.now());
            // Sacar de la cola las copias del tema ya encoladas (adiós a las que
            // hayan quedado en huecos del AutoDJ antes de banalo).
            if (_queue.songs?.length > 1) {
              _queue.songs = _queue.songs.filter((s, i) => i === 0 || s?.url !== current.url);
              await _queue.emit?.("updateQueue", _queue);
            }
            let skipMsg = "";
            if (_queue.songs.length > 1) {
              try { await _queue.skip(); skipMsg = " La salté."; } catch {}
            }
            client.updatequeue(_queue).catch(() => {});
            client.updateplayer(_queue).catch(() => {});
            return interaction.editReply({
              content: `🚫 Listo: **${current.name || "esa canción"}** ya no la va a poner el AutoDJ para vos.${skipMsg}`,
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          } catch (e) {
            return interaction.editReply({ content: "❌ No se pudo guardar la preferencia.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
        }

        //toggle autodj
        if (customId === "autodj") {
          const _queue = client.distube.getQueue(interaction.guildId);
          const _channel = interaction.member.voice.channel;
          if (!_channel) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
            return interaction.editReply({ content: "❌ Debes unirte a un canal de voz.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

          // Toggle OFF: pressing the button again deactivates Auto DJ.
          // El AutoDJ ya NO reordena tu lista, solo AGREGA canciones: entonces
          // apagarlo = sacar SOLO las que él metió (flag autoDj), y nada más.
          // Antes se restauraba un "snapshot" completo de la cola original, y si
          // habías hecho Stop/limpio el canal, ese snapshot volvía a meter toda
          // la lista vieja que ya no estabas escuchando.
          if (client.autoDj?.get(interaction.guildId)) {
            client.autoDj.delete(interaction.guildId);
            client.autoDjIntent?.delete(interaction.guildId);
            if (_queue?._autoDjSeen) { _queue._autoDjSeen.clear(); delete _queue._autoDjSeen; }
            if (_queue?._autoDjSelected) { _queue._autoDjSelected.clear(); delete _queue._autoDjSelected; }
            if (_queue?._autoDjExcludedSession) { _queue._autoDjExcludedSession.clear(); delete _queue._autoDjExcludedSession; }
            if (_queue) delete _queue._autoDjStep;   // el ciclo del patrón vuelve al paso 1
            if (_queue?.songs?.length) {
              // La que está SONANDO (songs[0]) se queda AUNQUE la haya metido el
              // bot: no se puede "des-reproducir" y quitarla dejaba la cola
              // "vacía" mientras seguía sonando (el 👍/skip apuntaban a la
              // canción equivocada o a nada). Solo salen las del bot que aún no
              // sonaron.
              const wasBot = (s) => !!(s && (s.autoDj || s._autoDj));
              let removed = 0;
              const cleaned = _queue.songs.filter((s, i) => {
                if (i === 0) return true;
                if (wasBot(s)) { removed++; return false; }
                return true;
              });
              for (const s of _queue.songs) if (s) { s.autoDj = false; s._autoDj = false; }
              _queue.songs = cleaned;
              client.logger.log(
                `[AutoDJ] OFF G:${interaction.guildId}: se quitaron ${removed} del bot por venir, queda la que suena + tu lista (${cleaned.length})`
              );
              client.updatequeue(_queue).catch(() => {});
            } else {
              // No había cola (p.ej. tras un Stop): NO tocar nada.
            }
            client.autoDjPrev?.delete(interaction.guildId);
            client.updateplayer(_queue).catch(() => {});
            const ID0 = client.temp.get(interaction.guildId);
            if (ID0) {
              const msg0 = interaction.channel.messages.cache.get(ID0) || await interaction.channel.messages.fetch(ID0).catch(() => null);
              if (msg0) msg0.edit({ components: client.buttons(false, _queue) }).catch(() => {});
            }
            return interaction.editReply({ content: "🛸 **Auto DJ apagado**\n▸ Quité las canciones del bot que aún no sonaban (la que está sonando sigue); tu lista queda igual que la pusiste." }).catch(() => {});
          }

          if (!_queue || !_queue.songs?.length) {
            return interaction.editReply({
              content: "❌ No hay una cola activa para activar el Auto DJ. Reproducí algo primero.",
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          }
          client.autoDj?.set(interaction.guildId, true);
          client.autoDjIntent?.set(interaction.guildId, true);

          // Responder SIEMPRE al instante para no dejar "Clubot está pensando" colgado.
          // El refinado/reordenamiento corre en background y refresca embeds.
          const listenerCount = _channel.members ? _channel.members.filter((m) => !m.user.bot).size : 0;
          const activationText = `🛸 **Auto DJ activado**\n▸ Intercalo EN MEDIO de tu lista: 🛸 una canción que te gustó (👍 o ⭐), sin repetirla pronto, y 🎲 una del resto de la lista que aún no sonó.\n▸ Aprovecho los gustos de ${listenerCount} que escuchan en el canal y NO repito canciones (ni entre sesiones).\n▸ Tu lista se respeta tal cual: solo se suman algunas de estas arriba.\n🔄 Pulsa el botón otra vez para deshacerlo.`;
          interaction.editReply({ content: activationText }).catch(() => {});

          try {
            client.autoDjRefill(_queue, { channel: _channel, force: true })
              .then(async () => {
                const queueNow = client.distube.getQueue(interaction.guildId) || _queue;
                client.updatequeue(queueNow).catch(() => {});
                client.updateplayer(queueNow).catch(() => {});
                const ID0 = client.temp.get(interaction.guildId);
                if (ID0) {
                  const msg0 = interaction.channel.messages.cache.get(ID0) || await interaction.channel.messages.fetch(ID0).catch(() => null);
                  if (msg0) msg0.edit({ components: client.buttons(false, queueNow) }).catch(() => {});
                }
                // Informar QUÉ pasó realmente: cuántas 🛸/🎲 entraron y, si no
                // había 🛸, el motivo (y cómo arreglarlo con 👍).
                const rep = client.autoDjReport?.get(interaction.guildId);
                if (rep) {
                  let extra = "";
                  if (rep.total > 0) {
                    extra = `\n\n📋 Añadí ${rep.total} ahora: ${rep.rec} 🛸 + ${rep.random} 🎲.`;
                  } else {
                    extra = `\n\n📋 No añadí canciones por ahora (la cola ya quedó completa).`;
                  }
                  const hasRecStep = Array.isArray(rep.pattern) && rep.pattern.some((p) => p.type === "rec");
                  if (hasRecStep && rep.rec === 0) {
                    extra += `\n⚠️ **Sin 🛸 para recomendar**: entre ${listenerCount} que escuchan no hay favoritas con 👍/⭐ fuera de las que ya están por sonar. Dale 👍 a una canción (o guardala con ⭐) y la tomo como recomendación.`;
                  }
                  interaction.editReply({ content: activationText + extra }).catch(() => {});
                }
              })
              .catch((err) => {
                client.logger.error(`[AutoDJ] Error en refill:`, err);
                client.updateplayer(client.distube.getQueue(interaction.guildId) || _queue).catch(() => {});
              });
          } catch (err) {
            client.logger.error(`[AutoDJ] Error:`, err);
            client.updateplayer(client.distube.getQueue(interaction.guildId) || _queue).catch(() => {});
          }
        }

        const controlButtons = ["previous", "rewind10", "pauseresume", "forward10", "skip", "stop", "shuffle", "loop_song", "loop_queue", "autoplay", "autodj"];

        // Paginación del embed de cola
        if (customId.startsWith("queue_page_")) {
          await interaction.deferUpdate().catch(() => {});
          if (!client.queuePages) client.queuePages = new Map();
          const freshQueue = client.distube.getQueue(interaction.guildId);
          if (!freshQueue || !freshQueue.songs.length) {
            client.queuePages.delete(interaction.guildId);
            return client.updatequeue(freshQueue).catch(() => {});
          }
          let maxTracks = 10;
          try {
            const stored = await client.music.get(`${interaction.guildId}.qlimit`);
            const n = Number(stored);
            if (Number.isInteger(n) && n > 0 && n <= 50) maxTracks = n;
          } catch (_e) {}
          const totalUpNext = Math.min(freshQueue.songs.length - 1, maxTracks);
          const totalPages = Math.max(1, Math.ceil(totalUpNext / client.QUEUE_PER_PAGE));
          let page = client.queuePages.get(interaction.guildId) || 0;
          if (customId === "queue_page_first") page = 0;
          else if (customId === "queue_page_prev") page = Math.max(0, page - 1);
          else if (customId === "queue_page_next") page = Math.min(totalPages - 1, page + 1);
          else if (customId === "queue_page_last") page = totalPages - 1;
          else return;
          client.queuePages.set(interaction.guildId, page);
          return client.updatequeue(freshQueue).catch(() => {});
        }
        if (!controlButtons.includes(customId)) return;
        DashboardFeed.logButton(customId, interaction);
        await interaction.deferUpdate().catch((e) => {});
        let voiceMember = interaction.guild.members.cache.get(member.id);
        let channel = voiceMember.voice.channel;
        let queue = client.distube.getQueue(interaction.guildId);
        let checkDJ = await check_dj(
          client,
          interaction.member,
          queue?.songs[0]
        );

        const refresh = (q, ms = 0) => {
          try {
            setTimeout(async () => {
              const guild = interaction.guild;
              // Trigger a global update for this guild
              await client.updatequeue(q).catch(() => {});
              await client.updateplayer(q).catch(() => {});
              
              // Also update standard temp player message if it exists
              const ID = client.temp.get(guild.id);
              if (ID) {
                const msg = interaction.channel.messages.cache.get(ID) || 
                          await interaction.channel.messages.fetch(ID).catch(() => null);
                if (msg) {
                  msg.edit({
                    components: client.buttons(false, q),
                  }).catch(() => {});
                }
              }
            }, ms);
          } catch {}
        };

  switch (customId) {
          case "previous":
            {
              if (!channel) return send(interaction, ` ${client.config.emoji.ERROR} Debes unirte a un canal de voz`);
              if (interaction.guild.members.me.voice.channel && !interaction.guild.members.me.voice.channel.equals(channel))
                return send(interaction, ` ${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz `);
              if (!queue) return send(interaction, ` ${client.config.emoji.ERROR} No hay nada sonando ahora `);
              if (checkDJ) return send(interaction, `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`);
              try {
                await queue.previous();
                refresh(queue, 300);
                return send(interaction, `${client.config.emoji.SUCCESS} Reproduciendo la pista anterior`);
              } catch (e) {
                return send(interaction, `${client.config.emoji.ERROR} No hay ninguna pista anterior disponible`);
              }
            }
            break;
          case "rewind10":
            {
              if (!channel) return send(interaction, ` ${client.config.emoji.ERROR} Debes unirte a un canal de voz`);
              if (interaction.guild.members.me.voice.channel && !interaction.guild.members.me.voice.channel.equals(channel))
                return send(interaction, ` ${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz `);
              if (!queue) return send(interaction, ` ${client.config.emoji.ERROR} No hay nada sonando ahora `);
              if (checkDJ) return send(interaction, `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`);
              const pos = Math.max(0, (queue.currentTime || 0) - 10);
              try {
                await queue.seek(pos);
                refresh(queue, 200);
                return send(interaction, `${client.config.emoji.SUCCESS} Retrocedido 10s`);
              } catch {}
            }
            break;
          case "forward10":
            {
              if (!channel) return send(interaction, ` ${client.config.emoji.ERROR} Debes unirte a un canal de voz`);
              if (interaction.guild.members.me.voice.channel && !interaction.guild.members.me.voice.channel.equals(channel))
                return send(interaction, ` ${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz `);
              if (!queue) return send(interaction, ` ${client.config.emoji.ERROR} No hay nada sonando ahora `);
              if (checkDJ) return send(interaction, `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`);
              const duration = queue.songs[0]?.duration || 0;
              const pos = Math.min(duration - 1, (queue.currentTime || 0) + 10);
              try {
                await queue.seek(pos);
                refresh(queue, 200);
                return send(interaction, `${client.config.emoji.SUCCESS} Avanzado 10s`);
              } catch {}
            }
            break;
          case "shuffle":
            {
              if (!channel) return send(interaction, ` ${client.config.emoji.ERROR} Debes unirte a un canal de voz`);
              if (interaction.guild.members.me.voice.channel && !interaction.guild.members.me.voice.channel.equals(channel))
                return send(interaction, ` ${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz `);
              if (!queue) return send(interaction, ` ${client.config.emoji.ERROR} No hay nada sonando ahora `);
              if (checkDJ) return send(interaction, `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`);
              try {
                await queue.shuffle();
                refresh(queue, 0);
                return send(interaction, `${client.config.emoji.SUCCESS} Lista mezclada`);
              } catch {}
            }
            break;
          case "autoplay":
            {
              if (!channel) {
                return send(
                  interaction,
                  `** ${client.config.emoji.ERROR} Debes unirte a un canal de voz**`
                );
              } else if (
                interaction.guild.members.me.voice.channel &&
                !interaction.guild.members.me.voice.channel.equals(channel)
              ) {
                return send(
                  interaction,
                  ` ${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz `
                );
              } else if (!queue) {
                return send(
                  interaction,
                  ` ${client.config.emoji.ERROR} No hay nada sonando ahora `
                );
              } else if (checkDJ) {
                return send(
                  interaction,
                  `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`
                );
              } else if (!queue.autoplay) {
                queue.toggleAutoplay();
                refresh(queue, 0);
                return send(
                  interaction,
                  ` ${client.config.emoji.SUCCESS} Reproducción automática activada `
                );
              } else {
                queue.toggleAutoplay();
                refresh(queue, 0);
                return send(
                  interaction,
                  ` ${client.config.emoji.SUCCESS} Reproducción automática desactivada `
                );
              }
            }
            break;
          case "skip":
            {
              if (!channel) {
                return send(
                  interaction,
                  ` ${client.config.emoji.ERROR} Debes unirte a un canal de voz`
                );
              } else if (
                interaction.guild.members.me.voice.channel &&
                !interaction.guild.members.me.voice.channel.equals(channel)
              ) {
                return send(
                  interaction,
                  ` ${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz `
                );
              } else if (!queue) {
                return send(
                  interaction,
                  ` ${client.config.emoji.ERROR} No hay nada sonando ahora `
                );
              } else if (checkDJ) {
                return send(
                  interaction,
                  `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`
                );
              } else {
                const gid = interaction.guildId;
                const now = Date.now();
                const lastSkip = client.skipLocks.get(gid) || 0;
                if (now - lastSkip < 1200) {
                  return send(
                    interaction,
                    ` ${client.config.emoji.SUCCESS} Ya se está saltando, procesando...`
                  );
                }
                client.skipLocks.set(gid, now);
                setTimeout(() => {
                  if (client.skipLocks.get(gid) === now) client.skipLocks.delete(gid);
                }, 1200);

                // Señal de "skip" (NO es un veto): el AutoDJ pasa a elegir esta
                // canción MENOS SEGUIDA, y solo para quien la saltó. Antes esto
                // excluía la canción del AutoDJ de TODO el servidor a los 2 skips.
                recordSkipSignal(client, gid, interaction.user.id, queue);

                skip(queue).catch(() => {});
                refresh(queue, 300);
                return send(
                  interaction,
                  `${client.config.emoji.SUCCESS} Canción saltada`
                );
              }
            }
            break;
          case "stop":
            {
              const guildId = interaction.guildId;
              const stoppedBy = interaction.user;

              if (queue) {
                if (checkDJ) {
                  return send(
                    interaction,
                    `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`
                  );
                }
                client.playlistLoading.delete(guildId);
                client.playlistStopped.set(guildId, Date.now());
                if (client._autoresumeTimers?.has(guildId)) {
                  clearInterval(client._autoresumeTimers.get(guildId));
                  client._autoresumeTimers.delete(guildId);
                }
                await client.autoresume.delete(guildId).catch(() => {});
                if (client.actualPlaying) client.actualPlaying.delete(guildId);
                queue.songs = [];
                await queue.stop().catch((e) => {});
              }

              // Always disconnect the bot and reset activity/nickname,
              // even if there is no active queue anymore.
              try {
                stopMarqueeActivity(client, interaction.guild);
              } catch {}
              try {
                await client.distube.voices.leave(interaction.guild);
              } catch {}
              try {
                await client.updateembed(client, interaction.guild);
                if (queue?.textChannel)
                  await client.editPlayerMessage(queue.textChannel);
              } catch {}

              client.autoDjDisable?.(guildId);
              client.logger.log(`[Stop Button] Música detenida en Guild ${guildId} por ${stoppedBy.id}`);
              return interaction.followUp({
                embeds: [
                  new EmbedBuilder()
                    .setColor(client.config.embed.color)
                    .setDescription(`> ${client.config.emoji.SUCCESS} La reproducción fue **detenida** por <@${stoppedBy.id}>`)
                    .setFooter(client.getFooter(stoppedBy)),
                ],
              }).catch(() => {});
            }
            break;
          case "pauseresume":
            {
              if (!channel) {
                return send(
                  interaction,
                  ` ${client.config.emoji.ERROR} Debes unirte a un canal de voz`
                );
              } else if (
                interaction.guild.members.me.voice.channel &&
                !interaction.guild.members.me.voice.channel.equals(channel)
              ) {
                return send(
                  interaction,
                  ` ${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz `
                );
              } else if (!queue) {
                return send(
                  interaction,
                  ` ${client.config.emoji.ERROR} No hay nada sonando ahora `
                );
              } else if (checkDJ) {
                return send(
                  interaction,
                  `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`
                );
              } else if (queue.paused) {
                await queue.resume();
                refresh(queue, 0);
                return send(
                  interaction,
                  ` ${client.config.emoji.SUCCESS} Lista reanudada `
                );
              } else {
                await queue.pause();
                refresh(queue, 0);
                return send(
                  interaction,
                  ` ${client.config.emoji.SUCCESS} Lista pausada `
                );
              }
            }
            break;
          case "loop_song":
            {
              if (!channel) return send(interaction, `${client.config.emoji.ERROR} Debes unirte a un canal de voz`);
              if (interaction.guild.members.me.voice.channel && !interaction.guild.members.me.voice.channel.equals(channel))
                return send(interaction, `${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz`);
              if (!queue) return send(interaction, `${client.config.emoji.ERROR} No hay nada sonando ahora`);
              if (checkDJ) return send(interaction, `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`);

              const newMode = queue.repeatMode === 1 ? 0 : 1;
              await queue.setRepeatMode(newMode);
              refresh(queue, 0);
              return send(
                interaction,
                `${client.config.emoji.SUCCESS} Bucle de canción ${newMode === 1 ? "activado" : "desactivado"}`
              );
            }
            break;

          case "loop_queue":
            {
              if (!channel) return send(interaction, `${client.config.emoji.ERROR} Debes unirte a un canal de voz`);
              if (interaction.guild.members.me.voice.channel && !interaction.guild.members.me.voice.channel.equals(channel))
                return send(interaction, `${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz`);
              if (!queue) return send(interaction, `${client.config.emoji.ERROR} No hay nada sonando ahora`);
              if (checkDJ) return send(interaction, `${client.config.emoji.SUCCESS} No eres DJ ni has solicitado esta canción..`);

              const newMode = queue.repeatMode === 2 ? 0 : 2;
              await queue.setRepeatMode(newMode);
              refresh(queue, 0);
              return send(
                interaction,
                `${client.config.emoji.SUCCESS} Bucle de cola ${newMode === 2 ? "activado" : "desactivado"}`
              );
            }
            break;

          default:
            break;
        }
      }

      // Handle select menu for preview playlist selection
      if (interaction.isStringSelectMenu() && interaction.customId === "fav_remove_select") {
        const idx1 = Number(interaction.values[0]);
        if (!idx1) return interaction.deferUpdate().catch(() => {});
        const removed = await Store.removeTrack(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", idx1);
        await interaction.deferUpdate().catch(() => {});
        const page = (client.favPages?.get(interaction.message.id) || 0);
        if (removed) {
          const { totalPages, newPage } = await (async () => {
            const favs = await Store.getSortedFavorites(client, interaction.guildId, interaction.user.id);
            const tp = Math.max(1, Math.ceil(favs.length / UserHistory.FAVORITES_PER_PAGE));
            const np = Math.max(0, Math.min(page, tp - 1));
            return { totalPages: tp, newPage: np };
          })();
          client.favPages.set(interaction.message.id, newPage);
          const embed = await UserHistory.buildFavoritesEmbed(client, interaction.guildId, interaction.user.id, newPage);
          if (!embed) {
            return interaction.editReply({
              embeds: [new EmbedBuilder().setColor("#00FF00").setDescription("✅ Todas las favoritas eliminadas.")],
              components: []
            }).catch(() => {});
          }
          const components = await UserHistory.buildFavoritesComponents(client, interaction.guildId, interaction.user.id, newPage);
          return interaction.editReply({ embeds: [embed], components }).catch(() => {});
        } else {
          return interaction.editReply({ content: "❌ No se encontró la canción.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }

      // Handle select menu for preview playlist selection
      if (interaction.isStringSelectMenu() && interaction.customId === "preview_select_playlist") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch((e) => {
          console.error("[Preview Select] deferReply failed:", e);
        });
        const value = interaction.values[0];
        const channel = interaction.member.voice.channel;
        if (!channel) {
          return interaction.editReply({ content: "❌ Debes unirte a un canal de voz." }).catch(() => {});
        }
        try {
          const playOpts = {
            member: interaction.member,
            textChannel: interaction.channel,
            selfDeaf: true,
          };
          if (value.startsWith("url:")) {
            const playlistUrl = value.slice(4);
            const result = await streamPlaylist({
              client,
              channel,
              playlistUrl,
              playOpts,
              onStatus: (msg) => interaction.editReply({ content: msg }).catch(() => {}),
            });
            if (!result.firstPlayed) {
              return interaction.editReply({ content: `❌ No se encontraron canciones en la lista o la primera falló.` }).catch(() => {});
            }
            logStream(client, interaction.guildId, `[Preview Select] Lista cargada: ${result.matchedCount} canciones.`);
            return interaction.editReply({ content: `✅ Cargando lista: \`${result.matchedCount}\` canciones.` }).catch(() => {});
          } else if (value.startsWith("store:")) {
            const playlistName = value.slice(6);
            const playlist = await Store.get(client, interaction.guildId, interaction.user.id, playlistName);
            if (!playlist || playlist.tracks.length === 0) {
              return interaction.editReply({ content: "❌ Lista vacía." }).catch(() => {});
            }
            try {
              await client.distube.voices.join(channel);
            } catch (e) {
              console.error("[Preview Select] Error joining voice:", e);
            }
            for (const track of playlist.tracks) {
              if (track.url) {
                await client.distube.play(channel, track.url, playOpts);
              }
            }
            return interaction.editReply({ content: `✅ Reproduciendo \`${playlist.name}\` (${playlist.tracks.length} canciones).` }).catch(() => {});
          }
        } catch (e) {
          console.error("[Preview Select] Error:", e);
          return interaction.editReply({ content: `❌ Error al reproducir: ${e.message || e}` }).catch(() => {});
        }
      }

      // Selección "🔀 Reproducir aleatorio": reproduce la lista elegida MEZCLADA
      // (como /reproduciraleatorio). La lista ya viene aleatorizada y el AutoDJ
      // solo intercala 🛸 recomendaciones en medio.
      if (interaction.isStringSelectMenu() && interaction.customId === "shuffle_select_playlist") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        const value = interaction.values[0];
        const channel = interaction.member.voice.channel;
        if (!channel) {
          return interaction.editReply({ content: "❌ Debes unirte a un canal de voz." }).catch(() => {});
        }
        const shufflePlayOpts = {
          member: interaction.member,
          textChannel: interaction.channel,
          selfDeaf: true,
        };
        try {
          let urls = [];
          let shuffleLabel = "";
          if (value.startsWith("url:")) {
            const playlistUrl = value.slice(4);
            shuffleLabel = playlistUrl;
            urls = await fetchPlaylistAllURLsFlat(playlistUrl, 1000);
            if (!urls.length) {
              return interaction.editReply({ content: "❌ No se pudieron obtener canciones de esa lista." }).catch(() => {});
            }
          } else if (value.startsWith("store:")) {
            const playlistName = value.slice(6);
            const playlist = await Store.get(client, interaction.guildId, interaction.user.id, playlistName);
            if (!playlist || !playlist.tracks.length) {
              return interaction.editReply({ content: "❌ Lista vacía." }).catch(() => {});
            }
            shuffleLabel = playlist.name;
            urls = playlist.tracks.map((t) => t.url).filter(Boolean);
            if (!urls.length) {
              return interaction.editReply({ content: "❌ La lista no tiene URLs válidas." }).catch(() => {});
            }
          } else {
            return interaction.editReply({ content: "❌ Opción inválida." }).catch(() => {});
          }
          const shuffleRes = await shufflePlay({
            client,
            channel,
            urls,
            playOpts: shufflePlayOpts,
            onStatus: (msg) => interaction.editReply({ content: msg }).catch(() => {}),
          });
          if (!shuffleRes.firstPlayed) {
            return interaction.editReply({ content: "❌ No se pudo reproducir la lista al azar." }).catch(() => {});
          }
          logStream(client, interaction.guildId, `[Shuffle Select] Lista aleatoria: ${shuffleRes.matchedCount} canciones.`);
          return interaction.editReply({ content: `✅ \`${shuffleLabel}\` reproduciéndose en modo aleatorio (${shuffleRes.matchedCount} canciones).` }).catch(() => {});
        } catch (e) {
          console.error("[Shuffle Select] Error:", e);
          return interaction.editReply({ content: `❌ Error: ${e.message || e}` }).catch(() => {});
        }
      }

      if (interaction.isStringSelectMenu() && interaction.customId === "delete_select_playlist") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        const value = interaction.values[0];
        if (!value.startsWith("delete:")) return interaction.editReply({ content: "❌ Valor inválido." }).catch(() => {});
        const playlistName = value.slice(7);
        const deleted = await Store.delete(client, interaction.guildId, interaction.user.id, playlistName);
        if (!deleted) {
          return interaction.editReply({ content: `❌ No se encontró la lista "${playlistName}".` }).catch(() => {});
        }
        return interaction.editReply({ content: `✅ Lista "${playlistName}" eliminada.` }).catch(() => {});
      }
    });

    // Handle modal submissions (favorites remove + like)
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.guild || interaction.user.bot) return;
      if (!interaction.isModalSubmit()) return;

      if (interaction.customId === "fav_remove_modal") {
        try {
          const raw = interaction.fields.getTextInputValue("fav_remove_indices");
          const indices = new Set();
          const parts = raw.split(/[,;\s]+/).filter(Boolean);
          for (const part of parts) {
            const rangeMatch = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
            if (rangeMatch) {
              const from = parseInt(rangeMatch[1], 10);
              const to = parseInt(rangeMatch[2], 10);
              if (!isNaN(from) && !isNaN(to) && from > 0 && to >= from) {
                for (let i = from; i <= to; i++) indices.add(i);
              }
            } else {
              const num = parseInt(part.trim(), 10);
              if (!isNaN(num) && num > 0) indices.add(num);
            }
          }
          if (!indices.size) {
            return interaction.reply({ content: "❌ No se encontraron números válidos.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }

          const removed = await Store.removeTracks(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", [...indices]);
          if (removed === 0) {
            return interaction.reply({ content: "❌ No se pudo eliminar ninguna canción. Verifica los números.", flags: MessageFlags.Ephemeral }).catch(() => {});
          }

          const favMsgId = client.favRemoveMsg?.get(interaction.user.id);
          client.favRemoveMsg?.delete(interaction.user.id);
          if (favMsgId) {
            const channel = interaction.channel;
            const favMsg = await channel.messages.fetch(favMsgId).catch(() => null);
            if (favMsg) {
              if (!client.favPages) client.favPages = new Map();
              const currentPage = client.favPages.get(favMsgId) || 0;
              const embed = await UserHistory.buildFavoritesEmbed(client, interaction.guildId, interaction.user.id, currentPage);
              const components = await UserHistory.buildFavoritesComponents(client, interaction.guildId, interaction.user.id, currentPage);
              if (embed) await favMsg.edit({ embeds: [embed], components }).catch(() => {});
            }
          }

          await interaction.reply({ content: `✅ Se eliminaron ${removed} canción(es).`, flags: MessageFlags.Ephemeral }).then((m) => client.scheduleDelete(m, interaction)).catch(() => {});
        } catch (e) {
          client.logger.error(`[Fav Remove Modal Error]`, e);
          interaction.reply({ content: "❌ Error al procesar.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }
    });

    async function send(interaction, string) {
      try {
        const sent = await interaction.followUp({
          embeds: [
            new EmbedBuilder()
              .setColor(client.config.embed.color)
              .setDescription(`> ${string.substring(0, 3000)}`)
              .setFooter(client.getFooter(interaction.user)),
          ],
          flags: MessageFlags.Ephemeral,
        });
        // OJO: los mensajes efímeros NO se borran con message.delete()
        // (no existen para la API del canal); solo con el webhook de la
        // interaction sobre ese mensaje concreto.
        client.scheduleDelete(sent, interaction);
      } catch (e) {
        client.logger?.error?.(`[Send] followUp falló:`, e?.message || e);
        client.scheduleDelete(interaction);
      }
    }
  } catch (e) {
    console.log(e);
  }
};
