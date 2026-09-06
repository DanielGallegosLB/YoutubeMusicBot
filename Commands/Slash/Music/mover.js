const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "mover",
  name_localizations: {
    "en-US": "move",
    "en-GB": "move",
  },
  description: `Mueve una canción en la cola`,
  description_localizations: {
    "en-US": "Move a song's position in the queue",
    "en-GB": "Move a song's position in the queue",
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
  options: [
    {
      name: "trackindex",
      description: `Song Index`,
      type: ApplicationCommandOptionType.Number,
      required: true,
    },
    {
      name: "targetindex",
      description: `Target Song Index`,
      type: ApplicationCommandOptionType.Number,
      required: true,
    },
  ],

  /**
   *
   * @param {MusicBot} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    // Code
    let songIndex = interaction.options.getNumber("trackindex");
    let position = interaction.options.getNumber("targetindex");
    if (!Number.isInteger(songIndex) || !Number.isInteger(position)) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR} Los índices deben ser números enteros.`
      );
    }
    if (songIndex < 1 || songIndex >= queue.songs.length) {
      return client.embed(
        interaction,
        ` **The last Song in the Queue has the Index: \`${queue.songs.length - 1}\`**`
      );
    } else if (position < 1) {
      return client.embed(
        interaction,
        `**Cannot move Song before Playing Song!**`
      );
    } else {
      let song = queue.songs[songIndex];
      //remove the song
      queue.songs.splice(songIndex, 1);
      //Add it to a specific Position
      let target = Math.floor(position);
      if (target > queue.songs.length) target = queue.songs.length;
      queue.songs.splice(target, 0, song);
      client.updatequeue(queue).catch(() => {});
      client.updateplayer(queue).catch(() => {});
      client.embed(
        interaction,
        `📑 Moved **${client.getTitle(
          song
        )}** to the **\`${target}th\`** Place right after **_${
          queue.songs[target - 1]?.name || "Unknown"
        }_!**`
      );
    }
  },
};
