const client = require("../index");
const {
  cooldown,
  check_dj,
  databasing,
  getPermissionName,
} = require("../handlers/functions");
const { emoji } = require("../settings/config");
const { ApplicationCommandOptionType, Events } = require("discord.js");

client.on(Events.InteractionCreate, async (interaction) => {
  // Autocomplete Handling
  if (interaction.isAutocomplete()) {
    const cmd = client.commands.get(interaction.commandName);
    if (cmd && typeof cmd.autocomplete === "function") {
      try {
        await cmd.autocomplete(client, interaction);
      } catch (e) {
        // swallow
      }
    }
    return;
  }

  // Slash Command Handling
  if (interaction.isChatInputCommand()) {
    try {
      await interaction.deferReply().catch((e) => {
        client.logger.error(`[Interaction Defer Error] Guild: ${interaction.guildId}`, e);
      });
    } catch (e) {}

    await databasing(interaction.guildId, interaction.user.id);

    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) {
      return client.embed(
        interaction,
        `${emoji.ERROR} \`${interaction.commandName}\` Command Not Found `
      );
    }
    const args = [];
    for (let option of interaction.options.data) {
      if (option.type === ApplicationCommandOptionType.Subcommand) {
        if (option.name) args.push(option.name);
        option.options?.forEach((x) => {
          if (x.value) args.push(x.value);
        });
      } else if (option.value) args.push(option.value);
    }

    if (cmd) {
      // checking user perms
      let queue = client.distube.getQueue(interaction.guild.id);
      let voiceChannel = interaction.member.voice.channel;
      let botChannel = interaction.guild.members.me.voice.channel;
      let checkDJ = await check_dj(client, interaction.member, queue?.songs[0]);

      if (!interaction.member.permissions.has(cmd.userPermissions || [])) {
        const needPerms = getPermissionName(cmd.userPermissions);
        return client.embed(
          interaction,
          `You Don't Have \`${needPerms}\` Permission to Use \`${cmd.name}\` Command!!`
        );
      } else if (
        !interaction.guild.members.me.permissions.has(cmd.botPermissions || [])
      ) {
        const needPerms = getPermissionName(cmd.botPermissions);
        return client.embed(
          interaction,
          `I Don't Have \`${needPerms}\` Permission to Run \`${cmd.name}\` Command!!`
        );
      } else if (cooldown(interaction, cmd)) {
        return client.embed(
          interaction,
          ` You are On Cooldown , wait \`${cooldown(
            interaction,
            cmd
          ).toFixed()}\` Seconds`
        );
      } else if (cmd.inVoiceChannel && !voiceChannel) {
        return client.embed(
          interaction,
          `${emoji.ERROR} You Need to Join Voice Channel`
        );
      } else if (
        cmd.inSameVoiceChannel &&
        botChannel &&
        !botChannel?.equals(voiceChannel)
      ) {
        return client.embed(
          interaction,
          `${emoji.ERROR} You Need to Join ${botChannel} Voice Channel`
        );
      } else if (cmd.Player && !queue) {
        return client.embed(interaction, `${emoji.ERROR} Music Not Playing`);
      } else if (cmd.djOnly && checkDJ) {
        return client.embed(
          interaction,
          `${emoji.ERROR} You are not DJ and also you are not song requester..`
        );
      } else {
        try {
          await cmd.run(client, interaction, args, queue);
        } catch (error) {
          client.logger.error(`[Command Error] ${cmd.name}`, error);
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: `❌ Error: ${error.message}`, ephemeral: true }).catch(() => {});
          } else {
            await interaction.reply({ content: `❌ Error: ${error.message}`, ephemeral: true }).catch(() => {});
          }
        }
      }
    }
  }

  // Context Menu Handling
  if (interaction.isContextMenuCommand()) {
    await interaction.deferReply({ ephemeral: true }).catch((e) => {});
    const command = client.commands.get(interaction.commandName);
    if (command) command.run(client, interaction);
  }

  // button handling and menu handling are processed in DistubeHandler.js
});
