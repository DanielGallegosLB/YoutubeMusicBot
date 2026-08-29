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
    let tracks = queue.songs;
    const newtracks = [];
    for (let i = 0; i < tracks.length; i++) {
      let exists = false;
      for (j = 0; j < newtracks.length; j++) {
        if (tracks[i].url === newtracks[j].url) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        newtracks.push(tracks[i]);
      }
    }
    //clear the Queue
    queue.remove();
    //now add every not dupe song again
    await newtracks.map((song, index) => {
      queue.addToQueue(song, index);
    });

    msg.edit(
      `** ${client.config.emoji.SUCCESS} Removed 🎧 \`${newtracks.length}\` Duplicate Songs From Queue **`
    );
  },
};
