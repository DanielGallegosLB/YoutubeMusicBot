const { EmbedBuilder, Events, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const MusicBot = require("./Client");
const Store = require("./PlaylistStore");
const UserHistory = require("./UserHistory");
const { check_dj, skip } = require("./functions");
const { fetchPlaylistURLs } = require("./PlaylistFetcher");

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

        // Handle "No sugerir" button
        if (customId.startsWith("no_suggest_")) {
          const userId = customId.replace("no_suggest_", "");
          if (member.id !== userId) {
            return interaction.reply({ content: "Este botón no es para ti.", ephemeral: true }).catch(() => {});
          }
          await UserHistory.setNoSuggestions(client, interaction.guildId, userId, true);
          return interaction.reply({ content: "✅ No recibirás más sugerencias al conectar.", ephemeral: true }).catch(() => {});
        }

        // Handle "Reproducir Favoritos" button
        if (customId === "suggest_favorites") {
          await interaction.deferUpdate().catch(() => {});
          const channel = interaction.member.voice.channel;
          if (!channel) {
            return interaction.followUp({ content: "❌ Debes unirte a un canal de voz.", ephemeral: true }).catch(() => {});
          }
          try {
            // Get all users in the voice channel
            const members = channel.members.filter((m) => !m.user.bot).map((m) => m.id);
            let favs;
            if (members.length > 1) {
              favs = await Store.getInterleavedFavorites(client, interaction.guildId, members);
            } else {
              const playlists = await Store.getAll(client, interaction.guildId, interaction.user.id);
              favs = playlists["Canciones Favoritas"] || [];
            }
            if (!favs || favs.length === 0) {
              return interaction.followUp({ content: "❌ No hay canciones favoritas.", ephemeral: true }).catch(() => {});
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
            return interaction.followUp({ content: label, ephemeral: true }).catch(() => {});
          } catch (e) {
            return interaction.followUp({ content: "❌ Error al reproducir favoritos.", ephemeral: true }).catch(() => {});
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
          const _queue = client.distube.getQueue(interaction.guildId);
          const _track = _queue?.songs?.[0];
          if (!_track || !_queue) return interaction.deferUpdate().catch(() => {});
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          await Store.create(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
          const existing = await Store.get(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
          const trackExists = existing?.tracks?.some((t) => t.url === _track.url);
          if (!trackExists) {
            const serialized = Store.serializeSong(_track, interaction.user);
            await Store.addTracks(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", [serialized]);
          }
          // Enforce one like per user per play
          const seq = _queue._playSeq || 0;
          const claimKey = `${interaction.guildId}|${_track.url}|${seq}`;
          if (!client.likeClaims) client.likeClaims = new Map();
          if (client.likeClaims.size > 5000) client.likeClaims.clear();
          let claims = client.likeClaims.get(claimKey);
          if (!claims) { claims = new Set(); client.likeClaims.set(claimKey, claims); }
          if (claims.has(interaction.user.id)) {
            return interaction.editReply({ content: "❌ Ya diste like a esta canción en esta reproducción." }).catch(() => {});
          }
          claims.add(interaction.user.id);
          const result = await Store.likeTrackByUrl(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", _track.url);
          if (!result) return interaction.editReply({ content: "❌ Error al procesar." }).catch(() => {});
          Store.sortFavorites(client, interaction.guildId, interaction.user.id).catch(() => {});
          client.updatequeue(_queue).catch(() => {});
          client.updateplayer(_queue).catch(() => {});
          const msg = `❤️ Like! (${result.score >= 0 ? "+" : ""}${result.score} pts · ${result.likeCount}❤️ ${result.dislikeCount}👎)`;
          return interaction.editReply({ content: msg }).catch(() => {});
        }

        if (customId === "player_dislike") {
          const _queue = client.distube.getQueue(interaction.guildId);
          const _track = _queue?.songs?.[0];
          if (!_track || !_queue) return interaction.deferUpdate().catch(() => {});
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          await Store.create(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
          const existing = await Store.get(client, interaction.guildId, interaction.user.id, "Canciones Favoritas");
          const trackExists = existing?.tracks?.some((t) => t.url === _track.url);
          if (!trackExists) {
            const serialized = Store.serializeSong(_track, interaction.user);
            await Store.addTracks(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", [serialized]);
          }
          // Enforce one dislike per user per play
          const seq = _queue._playSeq || 0;
          const claimKey = `${interaction.guildId}|${_track.url}|${seq}`;
          if (!client.likeClaims) client.likeClaims = new Map();
          let claims = client.likeClaims.get(claimKey);
          if (!claims) { claims = new Set(); client.likeClaims.set(claimKey, claims); }
          if (claims.has(interaction.user.id)) {
            return interaction.editReply({ content: "❌ Ya diste dislike a esta canción en esta reproducción." }).catch(() => {});
          }
          claims.add(interaction.user.id);
          const result = await Store.dislikeTrackByUrl(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", _track.url);
          if (!result) return interaction.editReply({ content: "❌ Error al procesar." }).catch(() => {});
          Store.sortFavorites(client, interaction.guildId, interaction.user.id).catch(() => {});
          client.updatequeue(_queue).catch(() => {});
          client.updateplayer(_queue).catch(() => {});
          return interaction.editReply({ content: `👎 Dislike! (${result.score >= 0 ? "+" : ""}${result.score} pts · ${result.likeCount}❤️ ${result.dislikeCount}👎)` }).catch(() => {});
        }

        if (customId === "autodj") {
          const _queue = client.distube.getQueue(interaction.guildId);
          if (!_queue || !_queue.songs?.length) return interaction.deferUpdate().catch(() => {});
          const _channel = interaction.member.voice.channel;
          if (!_channel) {
            await interaction.deferReply({ ephemeral: true }).catch(() => {});
            return interaction.editReply({ content: "❌ Debes unirte a un canal de voz.", ephemeral: true }).catch(() => {});
          }
          await interaction.deferReply({ ephemeral: true }).catch(() => {});

          // Toggle OFF: pressing the button again deactivates Auto DJ and restores the original order
          if (client.autoDj?.get(interaction.guildId)) {
            client.autoDj.delete(interaction.guildId);
            const snapshot = client.autoDjPrev?.get(interaction.guildId) || null;
            const kept = snapshot?.length ? snapshot.filter((s) => s !== _queue.songs[0]) : [];
            if (snapshot?.length) _queue.songs = [_queue.songs[0]].concat(kept);
            client.autoDjPrev?.delete(interaction.guildId);
            client.updateplayer(_queue).catch(() => {});
            const ID0 = client.temp.get(interaction.guildId);
            if (ID0) {
              const msg0 = interaction.channel.messages.cache.get(ID0) || await interaction.channel.messages.fetch(ID0).catch(() => null);
              if (msg0) msg0.edit({ components: client.buttons(false, _queue) }).catch(() => {});
            }
            const undoTxt = kept.length
              ? `▸ Restauré tu cola original (${kept.length} canciones pendientes) tal como estaba.\n▸ La canción actual sigue sonando.`
              : `▸ No había orden previo que restaurar.`;
            return interaction.editReply({ content: `🛸 Auto DJ desactivado\n${undoTxt}` }).catch(() => {});
          }
          client.autoDj?.set(interaction.guildId, true);
          client.autoDjPrev?.set(interaction.guildId, _queue.songs.slice());

          try {
            // 1) Current up-next songs already in queue (real DisTube Song objects)
            const upNext = _queue.songs.slice(1);

            // 2) User's favorites sorted best-first (score = (likes-dislikes)*10 + plays)
            const favs = await Store.getSortedFavorites(client, interaction.guildId, interaction.user.id);
            if (!favs.length) {
              client.autoDj?.delete(interaction.guildId);
              client.autoDjPrev?.delete(interaction.guildId);
              return interaction.editReply({ content: "❌ No tienes canciones favoritas para el Auto DJ. ¡Usa el botón ❤️ Like para añadirlas!" }).catch(() => {});
            }

            // 3) Dedup against songs already in the queue
            const known = new Set(_queue.songs.map((s) => s.url));
            const toAdd = favs.filter((f) => f.url && !known.has(f.url)).slice(0, 20);

            // 4) No new favorites to mix: just shuffle the existing up-next
            if (!toAdd.length) {
              if (!upNext.length) {
                client.autoDj?.delete(interaction.guildId);
                client.autoDjPrev?.delete(interaction.guildId);
                return interaction.editReply({ content: "❌ No hay canciones favoritas nuevas para reproducir." }).catch(() => {});
              }
              const shuffleOnly = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
              _queue.songs = [_queue.songs[0]].concat(shuffleOnly(upNext));
              client.updatequeue(_queue).catch(() => {});
              client.updateplayer(_queue).catch(() => {});
              const ID0 = client.temp.get(interaction.guildId);
              if (ID0) {
                const msg0 = interaction.channel.messages.cache.get(ID0) || await interaction.channel.messages.fetch(ID0).catch(() => null);
                if (msg0) msg0.edit({ components: client.buttons(false, _queue) }).catch(() => {});
              }
              return interaction.editReply({ content: `🛸 **Auto DJ activado**\n▸ No había favoritas nuevas para añadir.\n▸ Barajé ${upNext.length} canciones de tu cola actual.\n🔄 Pulsa el botón otra vez para deshacerlo y recuperar tu cola original.` }).catch(() => {});
            }

            // 5) Addition + reorder run in background so the button never blocks on heavy work
            interaction.editReply({ content: `🛸 Activando Auto DJ, añadiendo ${toAdd.length} favoritas...` }).catch(() => {});
            (async () => {
              try {
                const addedUrls = [];
                const seen = new Set(known);
                const playOpts = { member: interaction.member, textChannel: interaction.channel, selfDeaf: true, skip: false };
                for (let i = 0; i < toAdd.length; i++) {
                  const f = toAdd[i];
                  if (seen.has(f.url)) continue;
                  try {
                    await client.distube.play(_channel, f.url, playOpts);
                    addedUrls.push(f.url);
                    seen.add(f.url);
                  } catch (e) {
                    client.logger.error(`[AutoDJ] No se pudo añadir favorita ${f.url}:`, e?.message || e);
                  }
                  if (i + 1 === toAdd.length || (i + 1) % 5 === 0) {
                    interaction.editReply({ content: `🛸 Auto DJ: procesando favoritas ${i + 1}/${toAdd.length}...` }).catch(() => {});
                  }
                }

                const hadUpNext = upNext.length > 0;
                const addedCount = addedUrls.length;
                if (!addedCount && !hadUpNext) {
                  client.autoDj?.delete(interaction.guildId);
                  client.autoDjPrev?.delete(interaction.guildId);
                  return interaction.editReply({ content: "❌ No hay canciones favoritas nuevas para reproducir." }).catch(() => {});
                }

                // Grab the fresh queue and map real Song objects by URL
                const q = client.distube.getQueue(interaction.guildId) || _queue;
                const songByUrl = new Map();
                for (const s of q.songs) if (s.url && !songByUrl.has(s.url)) songByUrl.set(s.url, s);

                const favSongs = addedUrls.map((u) => songByUrl.get(u)).filter(Boolean);
                const upSongs = [];
                const seenUp = new Set();
                for (const s of upNext) {
                  if (!s.url || seenUp.has(s.url)) continue;
                  seenUp.add(s.url);
                  upSongs.push(songByUrl.get(s.url) || s);
                }

                // Mix: best-score favorites up front, then shuffle-blend favorites with the existing up-next
                const shuffleBg = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
                const lead = addedUrls.slice(0, 3).map((u) => songByUrl.get(u)).filter(Boolean);
                const favPool = shuffleBg(favSongs.filter((s) => !lead.includes(s)));
                const upPool = shuffleBg(upSongs);
                const mixed = [];
                while (lead.length) mixed.push(lead.shift());
                while (upPool.length || favPool.length) {
                  if (upPool.length && Math.random() < 0.6) mixed.push(upPool.shift());
                  else if (favPool.length) mixed.push(favPool.shift());
                  else if (upPool.length) mixed.push(upPool.shift());
                }

                // Replace the up-next portion of the queue with the mixed list
                q.songs = [q.songs[0]].concat(mixed);

                // Persist / refresh embeds without blocking playback
                client.updatequeue(q).catch(() => {});
                client.updateplayer(q).catch(() => {});
                const ID = client.temp.get(interaction.guildId);
                if (ID) {
                  const msg = interaction.channel.messages.cache.get(ID) || await interaction.channel.messages.fetch(ID).catch(() => null);
                  if (msg) msg.edit({ components: client.buttons(false, q) }).catch(() => {});
                }

                const leadTitles = addedUrls.slice(0, 3).map((u) => songByUrl.get(u)).filter(Boolean).map((s) => `\`${client.getTitle(s)}\``).join(", ");
                const summary = [`🛸 **Auto DJ activado**`];
                summary.push(`▸ Añadí ${addedCount} favorita${addedCount === 1 ? "" : "s"} al inicio${leadTitles ? `: ${leadTitles}.` : "."}`);
                summary.push(`▸ Mezclé ${mixed.length} canciones en cola barajando lo que ya tenías con tus favoritas.`);
                summary.push(`🔄 Pulsa el botón otra vez para deshacerlo y recuperar tu cola original.`);
                interaction.editReply({ content: summary.join("\n") }).catch(() => {});
              } catch (err) {
                client.logger.error(`[AutoDJ] Error:`, err);
                client.autoDj?.delete(interaction.guildId);
                client.autoDjPrev?.delete(interaction.guildId);
                client.updateplayer(client.distube.getQueue(interaction.guildId) || _queue).catch(() => {});
                interaction.editReply({ content: "❌ Ocurrió un error al activar el Auto DJ." }).catch(() => {});
              }
            })();
          } catch (err) {
            client.logger.error(`[AutoDJ] Error:`, err);
            client.autoDj?.delete(interaction.guildId);
            client.autoDjPrev?.delete(interaction.guildId);
            client.updateplayer(client.distube.getQueue(interaction.guildId) || _queue).catch(() => {});
            return interaction.editReply({ content: "❌ Ocurrió un error al activar el Auto DJ." }).catch(() => {});
          }
        }

        const controlButtons = ["previous", "rewind10", "pauseresume", "forward10", "skip", "stop", "shuffle", "loop_song", "loop_queue", "autoplay", "savecurrent_btn", "autodj"];

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
              if (!queue) {
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
                const guildId = interaction.guildId;
                const stoppedBy = interaction.user;
                client.playlistLoading.delete(guildId);
                client.playlistStopped.set(guildId, Date.now());
                await client.autoresume.delete(guildId).catch(() => {});
                queue.songs = [];
                await queue.stop().catch((e) => {});
                try {
                  const db = await client.music?.get(`${guildId}.vc`);
                  if (!db?.enable) await client.distube.voices.leave(interaction.guild);
                  try {
                    await client.updateembed(client, interaction.guild);
                    await client.editPlayerMessage(queue.textChannel);
                  } catch {}
                } catch {}
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

          case "savecurrent_btn":
            {
              // Validate context
              if (!channel) {
                return send(
                  interaction,
                  `${client.config.emoji.ERROR} Debes unirte a un canal de voz`
                );
              }
              if (
                interaction.guild.members.me.voice.channel &&
                !interaction.guild.members.me.voice.channel.equals(channel)
              ) {
                return send(
                  interaction,
                  `${client.config.emoji.ERROR} Debes unirte a __mi__ canal de voz`
                );
              }
              if (!queue || !queue.songs?.length) {
                return send(
                  interaction,
                  `${client.config.emoji.ERROR} No hay nada sonando ahora`
                );
              }

              // Open a private thread asking for playlist name
              const baseMsgId = client.temp.get(interaction.guildId);
              const baseMsg = baseMsgId
                ? await interaction.channel.messages.fetch(baseMsgId).catch(() => null)
                : null;
              const threadName = `guardar ▶ ${interaction.user.username}`.substring(0, 90);
              const starter = baseMsg || (await interaction.message?.fetch().catch(() => null)) || null;
              let thread;
              try {
                thread = await interaction.channel.threads.create({
                  name: threadName,
                  autoArchiveDuration: 60,
                  type: ChannelType.PrivateThread,
                  reason: `Solicitud de guardado de canción para ${interaction.user.tag}`,
                });
              } catch (e) {
                return send(
                  interaction,
                  `${client.config.emoji.ERROR} Necesito permiso para crear hilos en este canal.`
                );
              }
              // Invite only the clicker
              try { await thread.members.add(interaction.user.id).catch(() => {}); } catch {}
              await thread.send({
                content: `${interaction.user}, responde con el nombre de la lista para guardar "${client.getTitle(queue.songs[0])}" (tiempo límite 60s).`,
              });

              const collector = thread.createMessageCollector({
                time: 60_000,
                max: 1,
                filter: (m) => m.author.id === interaction.user.id,
              });

              collector.on("collect", async (m) => {
                const name = m.content.trim().slice(0, 64);
                const track = Store.serializeSong(queue.songs[0], interaction.user);
                await Store.create(client, interaction.guildId, interaction.user.id, name);
                await Store.addTracks(client, interaction.guildId, interaction.user.id, name, [track]);
                await thread.send(`${client.config.emoji.SUCCESS} Guardado en \`${name}\`. Este hilo se cerrará pronto.`);
              });

              collector.on("end", async () => {
                setTimeout(() => thread.setArchived(true, "Solicitud completada").catch(() => {}), 5000);
              });
            }
            break;

          default:
            break;
        }
      }

      // Handle select menu for preview playlist selection
      if (interaction.isStringSelectMenu() && interaction.customId === "preview_select_playlist") {
        await interaction.deferReply({ ephemeral: true }).catch((e) => {
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
            console.log(`[Preview Select] Fetching playlist URLs from: ${playlistUrl}`);
            const urls = await fetchPlaylistURLs(playlistUrl);
            console.log(`[Preview Select] Got ${urls.length} URLs`);
            if (urls.length === 0) {
              return interaction.editReply({ content: "❌ No se encontraron canciones en la lista." }).catch(() => {});
            }
            try {
              await client.distube.voices.join(channel);
            } catch (e) {
              console.error("[Preview Select] Error joining voice:", e);
            }
            await client.distube.play(channel, urls[0], playOpts);
            client.playlistLoading.set(interaction.guildId, true);
            (async () => {
              for (let i = 1; i < urls.length; i++) {
                if (!client.playlistLoading.get(interaction.guildId)) break;
                try {
                  await client.distube.play(channel, urls[i], { ...playOpts, skip: false });
                } catch (e) {}
                await new Promise((r) => setTimeout(r, 250));
              }
              client.playlistLoading.delete(interaction.guildId);
            })();
            return interaction.editReply({ content: `✅ Cargando lista: \`${urls.length}\` canciones.` }).catch(() => {});
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

      if (interaction.isStringSelectMenu() && interaction.customId === "delete_select_playlist") {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
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
            return interaction.reply({ content: "❌ No se encontraron números válidos.", ephemeral: true }).catch(() => {});
          }

          const removed = await Store.removeTracks(client, interaction.guildId, interaction.user.id, "Canciones Favoritas", [...indices]);
          if (removed === 0) {
            return interaction.reply({ content: "❌ No se pudo eliminar ninguna canción. Verifica los números.", ephemeral: true }).catch(() => {});
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

          await interaction.reply({ content: `✅ Se eliminaron ${removed} canción(es).`, ephemeral: true }).catch(() => {});
        } catch (e) {
          client.logger.error(`[Fav Remove Modal Error]`, e);
          interaction.reply({ content: "❌ Error al procesar.", ephemeral: true }).catch(() => {});
        }
        return;
      }
    });

    async function send(interaction, string) {
      await interaction.followUp({
        embeds: [
          new EmbedBuilder()
            .setColor(client.config.embed.color)
            .setDescription(`> ${string.substring(0, 3000)}`)
            .setFooter(client.getFooter(interaction.user)),
        ],
        ephemeral: true,
      }).catch((e) => null);
    }
  } catch (e) {
    console.log(e);
  }
};
