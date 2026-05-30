const { Message, PermissionFlagsBits, Colors } = require("discord.js");
const JUGNU = require("../../../handlers/Client");
const { Queue } = require("distube");

module.exports = {
  name: "latencia",
  aliases: ["ping"],
  description: `Obtén la información de ping y latencia del bot`,
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.EmbedLinks,
  category: "Information",
  cooldown: 5,
  inVoiceChannel: false,
  inSameVoiceChannel: false,
  Player: false,
  djOnly: false,

  /**
   *
   * @param {JUGNU} client
   * @param {Message} message
   * @param {String[]} args
   * @param {String} prefix
   * @param {Queue} queue
   */
  run: async (client, message, args, prefix, queue) => {
    // Get the timestamp at the start to calculate bot latency later
    const startTime = Date.now();

    // Send a temporary message to calculate message and round-trip latency
    const tempMessage = await message.reply({
      embeds: [
        {
          description: "Obtén la información de ping y latencia del bot",
          color: Colors.Blurple,
          footer: { text: "Por favor espera un momento..." },
        },
      ],
    });

    // Calculating latencies
    const messageLatency =
      tempMessage.createdTimestamp - message.createdTimestamp; // Message latency (time between send & receive)
    const botLatency = Date.now() - startTime; // Bot processing latency (time for bot to reply)
    const apiLatency = Math.round(client.ws.ping); // WebSocket (API) latency
    const totalLatency = botLatency + apiLatency;

    // Update the temp message with actual latency information
    await tempMessage.edit({
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
            url: "https://i.imgur.com/AfFp7pu.png", // You can add a custom thumbnail URL for aesthetic purposes
          },
          footer: {
            text: "Estado del bot: En línea ⚡ | Todos los pings medidos en milisegundos (ms)",
            icon_url: client.user.displayAvatarURL(), // Shows the bot's avatar in the footer
          },
          timestamp: new Date(), // Adds a timestamp of when the ping was measured
        },
      ],
    });
  },
};

// Function to format milliseconds into a readable string
function formatMilliseconds(ms) {
  return `${ms}ms`;
}
