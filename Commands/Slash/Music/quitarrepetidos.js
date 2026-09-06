const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "quitarrepetidos",
  name_localizations: {
    "en-US": "removedupes",
    "en-GB": "removedupes",
  },
  description: `Quita las canciones repetidas de la cola`,
  description_localizations: {
    "en-US": "Remove duplicate songs from the queue",
    "en-GB": "Remove duplicate songs from the queue",
  },
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Music",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: true,
  inSameVoiceChannel: true,
  Player: true,
  djOnly: true,

  /**
   *
   * @param {MusicBot} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    // Code
    let msg = await interaction.followUp(
      `** ${client.config.emoji.time} Removing Duplicate 🎧 Songs From Queue Wait **`
    );
    const seen = new Set();
    const kept = [];
    for (const track of queue.songs) {
      const key = track?.url || `${track?.name || ""}|${track?.duration || 0}`;
      if (!seen.has(key)) {
        seen.add(key);
        kept.push(track);
      }
    }
    const removed = queue.songs.length - kept.length;
    queue.songs = kept;
    client.updatequeue(queue).catch(() => {});
    client.updateplayer(queue).catch(() => {});
    msg.edit(
      `** ${client.config.emoji.SUCCESS} Removed 🎧 \`${removed}\` Duplicate Songs From Queue **`
    );
  },
};
