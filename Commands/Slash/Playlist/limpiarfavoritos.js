const {
  CommandInteraction,
  PermissionFlagsBits,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require("discord.js");
const MusicBot = require("../../../handlers/Client");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "limpiarfavoritos",
  name_localizations: {
    "en-US": "clearfavorites",
    "en-GB": "clearfavorites",
  },
  description: `Vacía las Canciones Favoritas de un usuario SIN borrar sus likes`,
  description_localizations: {
    "en-US": "Empty a user's Favorites WITHOUT deleting their likes",
    "en-GB": "Empty a user's Favorites WITHOUT deleting their likes",
  },
  userPermissions: PermissionFlagsBits.Connect,
  botPermissions: PermissionFlagsBits.Connect,
  category: "Playlist",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      name: "usuario",
      name_localizations: { "en-US": "user", "en-GB": "user" },
      description: "Usuario cuyos favoritos querés vaciar (por defecto: vos)",
      description_localizations: {
        "en-US": "User whose favorites to empty (defaults to you)",
        "en-GB": "User whose favorites to empty (defaults to you)",
      },
      type: ApplicationCommandOptionType.User,
      required: false,
    },
    {
      name: "confirmar",
      name_localizations: { "en-US": "confirm", "en-GB": "confirm" },
      description: "Confirmá para vaciar los favoritos definitivamente",
      description_localizations: {
        "en-US": "Confirm to permanently empty the favorites",
        "en-GB": "Confirm to permanently empty the favorites",
      },
      type: ApplicationCommandOptionType.Boolean,
      required: true,
    },
  ],

  /**
   *
   * @param {MusicBot} client
   * @param {CommandInteraction} interaction
   * @param {String[]} args
   * @param {import("distube").Queue} queue
   */
  run: async (client, interaction, args, queue) => {
    const target =
      interaction.options.getUser("usuario") || interaction.user;
    const confirm = interaction.options.getBoolean("confirmar");

    const isSelf = target.id === interaction.user.id;
    const canManage =
      isSelf ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!canManage) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR || "❌"} Solo puedes vaciar tus propios favoritos.`
      );
    }

    const existing = await Store.get(
      client,
      interaction.guildId,
      target.id,
      "Canciones Favoritas"
    ).catch(() => null);
    const total = existing?.tracks?.length || 0;

    if (!confirm) {
      return client.embed(
        interaction,
        `${client.config.emoji.WARNING || "⚠️"} **${target.username}** tiene **${total}** canción(es) en Favoritas.\n` +
          `Vaciar la lista **NO borra sus 👍/👎/reproducciones**: esos datos viven aparte y el AutoDJ los sigue usando.\n` +
          `Vuelve a ejecutar con \`confirmar: true\` para vaciarla.`
      );
    }

    const res = await Store.clearFavoritesPreservingLikes(
      client,
      interaction.guildId,
      target.id
    );

    client.logger.log(
      `[LimpiarFavoritos] <@${target.id}> (${target.id}): ${res.removed} favoritas vaciadas; ` +
        `likes preservados (${res.likes}👍 ${res.dislikes}👎 ${res.plays}🔥) por ${interaction.user.id}`
    );

    if (res.removed === 0) {
      return client.embed(
        interaction,
        `${client.config.emoji.SUCCESS || "✅"} **${target.username}** no tenía canciones en Favoritas.`
      );
    }

    return client.embed(
      interaction,
      `${client.config.emoji.SUCCESS || "✅"} Se vaciaron **${res.removed}** canción(es) de Favoritas de **${target.username}**.\n` +
        `Sus likes siguen intactos: **${res.likes}👍 · ${res.dislikes}👎 · ${res.plays}🔥** (guardados aparte).`
    );
  },
};
