const { ApplicationCommandType, ApplicationCommandOptionType, PermissionFlagsBits } = require("discord.js");
const Store = require("../../../handlers/PlaylistStore");

module.exports = {
  name: "limpiarbasura",
  name_localizations: {
    "en-US": "cleangarbage",
    "en-GB": "cleangarbage",
  },
  description: `Elimina las canciones basura de las Favoritas de un usuario (las que no tienen 👍 ni ⭐)`,
  description_localizations: {
    "en-US": "Delete the junk songs from a user's Favorites (those without 👍 or ⭐)",
    "en-GB": "Delete the junk songs from a user's Favorites (those without 👍 or ⭐)",
  },
  userPermissions: PermissionFlagsBits.SendMessages,
  botPermissions: PermissionFlagsBits.SendMessages,
  category: "Music",
  cooldown: 5,
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      name: "usuario",
      name_localizations: { "en-US": "user", "en-GB": "user" },
      description: "Usuario cuyas Favoritas querés limpiar",
      description_localizations: { "en-US": "User whose Favorites you want to clean", "en-GB": "User whose Favorites you want to clean" },
      type: ApplicationCommandOptionType.User,
      required: true,
    },
    {
      name: "confirmar",
      name_localizations: { "en-US": "confirm", "en-GB": "confirm" },
      description: `Ponlo en true para borrar de verdad (sin confirmar solo muestra cuántas había)`,
      description_localizations: { "en-US": "Set to true to actually delete (without it, only shows the count)", "en-GB": "Set to true to actually delete (without it, only shows the count)" },
      type: ApplicationCommandOptionType.Boolean,
      required: true,
    },
  ],
  run: async (client, interaction) => {
    const targetUser = interaction.options.getUser("usuario");
    const confirm = interaction.options.getBoolean("confirmar");
    if (!targetUser) return client.embed(interaction, `${client.config.emoji.ERROR} Usuario inválido.`);

    const isAdmin =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (targetUser.id !== interaction.user.id && !isAdmin) {
      return client.embed(
        interaction,
        `${client.config.emoji.ERROR} Solo podés limpiar **tus** Favoritas (o pedile a un admin).`,
      );
    }

    const guildId = interaction.guildId || interaction.guild.id;
    const stats = await Store.getUnlikedFavoritesForUser(client, guildId, targetUser.id);

    if (!confirm) {
      const safe = stats.unliked > 0 ? "" : " No hay nada que limpiar. ✅";
      return client.embed(
        interaction,
        `${client.config.emoji.WARNING || "⚠️"} **${targetUser.username}** tiene **${stats.total}** canciones en Favoritas: **${stats.real}** reales (👍/⭐) y **${stats.unliked}** basura (sin 👍 ni ⭐).${safe}\nVolvé a ejecutarlo con \`confirmar: true\` para borrarlas definitivamente.`,
      );
    }

    const res = await Store.pruneUnlikedFavoritesForUser(client, guildId, targetUser.id);

    if (res.removed === 0) {
      return client.embed(
        interaction,
        `${client.config.emoji.SUCCESS} **${targetUser.username}** no tenía basura en sus Favoritas (${res.kept} reales, todo limpio).`,
      );
    }
    const samples = (res.samples || []).filter(Boolean).length
      ? `\nEjemplos de lo eliminado:\n▸ ${res.samples.filter(Boolean).slice(0, 3).join("\n▸ ")}`
      : "";
    client.logger.log(
      `[LimpiarBasura] <@${targetUser.id}> (${targetUser.id}): ${res.removed} basura eliminada, ${res.kept} reales quedan (por ${interaction.user.id})`,
    );
    return client.embed(
      interaction,
      `${client.config.emoji.SUCCESS} Se eliminaron **${res.removed}** canciones basura de **${targetUser.username}** (quedan **${res.kept}** reales).${samples}`,
    );
  },
};