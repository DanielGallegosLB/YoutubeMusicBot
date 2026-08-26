const { ActivityType, Events } = require("discord.js");
const client = require("../index");
const { registerSlashCommands } = require("../handlers/functions");
const Database = require("../handlers/Database");

client.once(Events.ClientReady, async () => {
  try {
    client.logger.log(`${client.user.username} is Online`);

    // Reset bot activity
    client.user.setActivity({
      name: `By @Dani | ${client.guilds.cache.size} Servers`,
      type: ActivityType.Watching,
    });

    // Reset nickname in all guilds
    for (const guild of client.guilds.cache.values()) {
      const me = guild.members.me;
      if (me && me.nickname) {
        await me.setNickname(null).catch(() => {});
      }
    }

    // Load database
    await Database(client);

    // Reset music embeds for all guilds one by one
    for (const guild of client.guilds.cache.values()) {
      await client.updateembed(client, guild);
    }

    // Register slash commands
    await registerSlashCommands(client);
  } catch (error) {
    console.error("An error occurred during initialization:", error);
  }
});
