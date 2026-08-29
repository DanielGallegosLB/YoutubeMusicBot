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
} = require("discord.js");
const { Queue, Song } = require("distube");
const PlaylistStore = require("./PlaylistStore");

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

    // Row 3: Auto DJ 🛸 • Like ❤️ • Dislike 👎 • SaveCurrent ⭐
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
        .setEmoji("❤️")
        .setLabel("Like")
        .setDisabled(dis(!track)),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("player_dislike")
        .setEmoji("👎")
        .setLabel("Dislike")
        .setDisabled(dis(!track)),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId("savecurrent_btn")
        .setEmoji("⭐")
        .setLabel("Save Current Song")
        .setDisabled(dis(!track)),
    ]);

    return [row1, row2, row3];
  };

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
  client.updateembed = async (client, guild) => {
    try {
      const data = await client.music.get(`${guild.id}.music`);
      if (!data || !data.channel) return;

      const musicchannel = guild.channels.cache.get(data.channel) || await guild.channels.fetch(data.channel).catch(() => null);
      if (!musicchannel) return;

      // Fetch both playmsg and queuemsg simultaneously
      let playmsg = await musicchannel.messages.fetch(data.pmsg).catch(() => null);
      let queuemsg = await musicchannel.messages.fetch(data.qmsg).catch(() => null);

      // Self-Repair: If messages are missing, recreate them
      if (!playmsg || !queuemsg) {
        client.logger.warn(`[Self-Repair] Missing messages in ${guild.name}. Recreating...`);
        // Clean up any remaining one if it exists
        if (playmsg) await playmsg.delete().catch(() => {});
        if (queuemsg) await queuemsg.delete().catch(() => {});

        const pMsg = await musicchannel.send({
          embeds: [client.playembed(guild)],
          components: client.buttons(true),
        });
        const qMsg = await musicchannel.send({
          embeds: [client.queueembed(guild)],
        });

        await client.music.set(`${guild.id}.music`, {
          channel: data.channel,
          pmsg: pMsg.id,
          qmsg: qMsg.id,
        });
        return;
      }

      // Edit playmsg and queuemsg simultaneously
      await Promise.all([
        playmsg.edit({
          embeds: [client.playembed(guild)],
          components: client.buttons(true),
        }).catch(() => {}),
        queuemsg.edit({ embeds: [client.queueembed(guild)] }).catch(() => {}),
      ]);
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
  client.updatequeue = async (queue) => {
    try {
      const guildId = queue?.textChannel?.guildId || queue?.guildId;
      if (!guildId) return;
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return;

      const data = await client.music.get(`${guild.id}.music`);
      if (!data || !data.channel) return;

      const musicchannel = guild.channels.cache.get(data.channel) || await guild.channels.fetch(data.channel).catch(() => null);
      if (!musicchannel) return;

      let queueembed = await musicchannel.messages.fetch(data.qmsg).catch(() => null);

      // Self-Repair Trigger
      if (!queueembed) {
        return await client.updateembed(client, guild);
      }

      // Always get the freshest state from distube
      const freshQueue = client.distube.getQueue(guild.id) || queue;
      
      // If no queue, reset to empty
      if (!freshQueue || !freshQueue.songs.length) {
        client.queuePages?.delete(guild.id);
        client.autoDj?.delete(guild.id);
        return await queueembed.edit({ embeds: [client.queueembed(guild)], components: [] }).catch(() => {});
      }

      const currentSong = freshQueue.songs[0];

      const allPlaylists = await client.music.get(`${guild.id}.playlists`).catch(() => null) || {};

      const currentStats = currentSong?.url ? await PlaylistStore.getGlobalTrackStats(client, guildId, currentSong.url, allPlaylists).catch(() => ({ likes: 0, dislikes: 0, plays: 0 })) : { likes: 0, dislikes: 0, plays: 0 };
      const currentStatsParts = [];
      if (currentStats.likes > 0) currentStatsParts.push(`❤️${currentStats.likes}`);
      if (currentStats.dislikes > 0) currentStatsParts.push(`👎${currentStats.dislikes}`);
      if (currentStats.plays > 0) currentStatsParts.push(`🔥${currentStats.plays}`);
      const currentStatsText = currentStatsParts.length > 0 ? ` | ${currentStatsParts.join(" ")}` : "";

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
        track.url ? PlaylistStore.getGlobalTrackStats(client, guildId, track.url, allPlaylists).catch(() => ({ likes: 0, dislikes: 0, plays: 0 })) : Promise.resolve({ likes: 0, dislikes: 0, plays: 0 })
      ));
      let queueString = "";
      upNextTracks.forEach((track, i) => {
        const index = from + i;
        const tStats = upNextStats[i] || { likes: 0, dislikes: 0, plays: 0 };
        const tStatsParts = [];
        if (tStats.likes > 0) tStatsParts.push(`❤️${tStats.likes}`);
        if (tStats.dislikes > 0) tStatsParts.push(`👎${tStats.dislikes}`);
        if (tStats.plays > 0) tStatsParts.push(`🔥${tStats.plays}`);
        const tStatsStr = tStatsParts.length > 0 ? ` | ${tStatsParts.join(" ")}` : "";
        queueString += `\`${index}.\` **${client.getTitle(track)}** - ${
          track.isLive ? "LIVE STREAM" : track.formattedDuration.split(" | ")[0]
        } - \`${track.user.tag}\`${tStatsStr}\n`;
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
            } - \`${currentSong?.user.tag}\`${currentStatsText}`,
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
   * @returns
   */
  client.updateplayer = async (queue) => {
    try {
      const guildId = queue?.textChannel?.guildId || queue?.guildId;
      if (!guildId) return;
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return;

      const data = await client.music.get(`${guild.id}.music`);
      if (!data || !data.channel) return;

      const musicchannel = guild.channels.cache.get(data.channel) || await guild.channels.fetch(data.channel).catch(() => null);
      if (!musicchannel) return;

      let playembed = await musicchannel.messages.fetch(data.pmsg).catch(() => null);

      // Self-Repair Trigger
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

      const track = freshQueue.songs[0];
      if (!track || !track.name) return;

      const stats = track.url ? await PlaylistStore.getGlobalTrackStats(client, guildId, track.url).catch(() => ({ likes: 0, dislikes: 0, plays: 0, likedBy: [], dislikedBy: [] })) : { likes: 0, dislikes: 0, plays: 0, likedBy: [], dislikedBy: [] };
      const statsParts = [];
      if (stats.likes > 0) statsParts.push(`❤️${stats.likes}`);
      if (stats.dislikes > 0) statsParts.push(`👎${stats.dislikes}`);
      if (stats.plays > 0) statsParts.push(`🔥${stats.plays}`);
      const likeNames = (stats.likedBy || []).length ? `\nLikes: ${stats.likedBy.join(", ")}` : "";
      const dislikeNames = (stats.dislikedBy || []).length ? `\nDislikes: ${stats.dislikedBy.join(", ")}` : "";
      const statsValue = stats.likes > 0 || stats.dislikes > 0 || stats.plays > 0
        ? `${statsParts.join(" · ")}${likeNames}${dislikeNames}`
        : "Sin stats aún";

      const newEmbed = new EmbedBuilder()
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

      await playembed.edit({
        embeds: [newEmbed],
        components: client.buttons(false, freshQueue),
      }).catch(() => {});
    } catch (error) {
      console.error("Error updating player:", error);
    }
  };

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
      ephemeral: true,
    });

    const filter = async (i) => {
      if (i.user.id === user.id) return true;
      else {
        await i.deferReply().catch(() => {});
        i.followUp({
          content: `Not Your Interaction !!`,
          ephemeral: true,
        }).catch(() => {});
        return false;
      }
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
