const { ActivityType, ChannelType, PermissionFlagsBits } = require("discord.js");

const activityIntervals = new Map();

/** true si el canal de voz no es visible para @everyone (privado / oculto) */
function isPrivateVoice(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) return false;
  try {
    const everyone = channel.guild.roles.everyone;
    const perms = channel.permissionsFor(everyone);
    // Si @everyone no puede ver el canal → se considera privado/oculto
    return !perms?.has(PermissionFlagsBits.ViewChannel);
  } catch {
    return false;
  }
}

function startMarqueeActivity(client, text, guild, voiceChannel = null) {
  stopMarqueeActivity(client, guild);

  // Canal privado/oculto: NO cambiar actividad ni nickname (ofuscar uso del bot)
  if (voiceChannel && isPrivateVoice(voiceChannel)) {
    return;
  }

  const paddedText = `          ♪ ${text} ♪          `;
  let pos = 0;

  const update = () => {
    const rotated = paddedText.slice(pos) + paddedText.slice(0, pos);
    try {
      client.user.setActivity(rotated, { type: ActivityType.Playing });
    } catch (e) {}
    pos = (pos + 1) % paddedText.length;
  };

  update();
  const interval = setInterval(update, 4000);
  activityIntervals.set(client.user.id, interval);

  if (guild) {
    guild.members.me.setNickname(`♪ ${text}`.substring(0, 32)).catch(() => {});
  }
}

function stopMarqueeActivity(client, guild) {
  const interval = activityIntervals.get(client.user.id);
  if (interval) {
    clearInterval(interval);
    activityIntervals.delete(client.user.id);
  }
  try {
    client.user.setActivity(null);
  } catch (e) {}
  if (guild) {
    guild.members.me.setNickname(null).catch(() => {});
  }
}

module.exports = { startMarqueeActivity, stopMarqueeActivity, isPrivateVoice };