const { EmbedBuilder, Events, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const JUGNU = require("./Client");
const Store = require("./PlaylistStore");
const UserHistory = require("./UserHistory");
const { check_dj, skip } = require("./functions");
const { fetchPlaylistURLs } = require("./PlaylistFetcher");

/**
 *
 * @param {JUGNU} client
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
          await Store.sortFavorites(client, interaction.guildId, interaction.user.id);
          await client.updatequeue(_queue).catch(() => {});
          await client.updateplayer(_queue).catch(() => {});
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
          await Store.sortFavorites(client, interaction.guildId, interaction.user.id);
          await client.updatequeue(_queue).catch(() => {});
          await client.updateplayer(_queue).catch(() => {});
          return interaction.editReply({ content: `👎 Dislike! (${result.score >= 0 ? "+" : ""}${result.score} pts · ${result.likeCount}❤️ ${result.dislikeCount}👎)` }).catch(() => {});
        }

        const controlButtons = ["previous", "rewind10", "pauseresume", "forward10", "skip", "stop", "shuffle", "loop_song", "loop_queue", "autoplay", "savecurrent_btn"];
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
                await skip(queue);
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
                const guildId = interaction.guildId;
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
                client.logger.log(`[Stop Button] Música detenida en Guild ${guildId} por ${interaction.user.id}`);
                return send(
                  interaction,
                  ` ${client.config.emoji.SUCCESS} ¡Música detenida y el bot ha salido del canal!`
                );
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
