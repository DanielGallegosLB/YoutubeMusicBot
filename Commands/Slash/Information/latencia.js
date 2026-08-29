const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  Colors,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "latencia",
  name_localizations: {
    "en-US": "ping",
    "en-GB": "ping",
  },
  description: `Obtén la información de ping y latencia del bot`,
  description_localizations: {
    "en-US": "View the bot's latency",
    "en-GB": "View the bot's latency",
  },
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Information",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,

  /**
   *
   * @param {MusicBot} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    const startTime = Date.now();

    // Send an initial message to calculate latencies
    const tempMessage = await interaction.editReply({
      embeds: [
        {
          description: "Obtén la información de ping y latencia del bot",
          description_localizations: {
            "en-US": "View the bot's latency",
            "en-GB": "View the bot's latency",
          },
          color: Colors.Blurple,
          footer: { text: "Por favor espera un momento..." },
        },
      ],
    });

    // Calculating latencies
    const messageLatency =
      tempMessage.createdTimestamp - interaction.createdTimestamp; // Message latency
    const botLatency = Date.now() - startTime; // Bot processing latency
    const apiLatency = Math.max(Math.round(client.ws.ping), 0); // Ensure no negative API latency
    const totalLatency = botLatency + apiLatency; // Total latency

    // Edit the initial reply with latency details
    await interaction.editReply({
      embeds: [
        {
          title: "🏓 **¡Pong!**",
          description: "Aquí están los detalles de la latencia:",
          color: Colors.Gold,
          fields: [
            {
              name: "🤖 **Latencia del Bot**",
              value: `\`${formatMilliseconds(botLatency)}\``,
              inline: true,
            },
            {
              name: "💬 **Latencia de Mensaje**",
              value: `\`${formatMilliseconds(messageLatency)}\``,
              inline: true,
            },
            {
              name: "📡 **Latencia de API**",
              value: `\`${formatMilliseconds(apiLatency)}\``,
              inline: true,
            },
            {
              name: "🌍 **Latencia Total de Ida y Vuelta**",
              value: `\`${formatMilliseconds(totalLatency)}\``,
              inline: false,
            },
          ],
          thumbnail: {
            url: "https://i.imgur.com/AfFp7pu.png", // Thumbnail image URL
          },
          footer: {
            text: "Estado del bot: En línea ⚡ | Todos los pings medidos en milisegundos (ms)",
            icon_url: client.user.displayAvatarURL(),
          },
          timestamp: new Date(), // Adds timestamp of when the ping was measured
        },
      ],
    });
  },
};

// Function to format milliseconds into a readable string
function formatMilliseconds(ms) {
  return `${ms}ms`;
}
