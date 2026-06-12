const { EmbedBuilder, Events, ChannelType } = require("discord.js");
const JUGNU = require("./Client");
const Store = require("./PlaylistStore");
const { check_dj, skip } = require("./functions");

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
        await interaction.deferUpdate().catch((e) => {});
        const { customId, member } = interaction;
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
                client.playlistLoading.delete(interaction.guildId);
                await queue.stop().catch((e) => {});
                try {
                  await client.distube.voices.leave(interaction.guild);
                  // Reset embeds to default immediately
                  try {
                    await client.updateembed(client, interaction.guild);
                    await client.editPlayerMessage(queue.textChannel);
                  } catch {}
                } catch {}
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
