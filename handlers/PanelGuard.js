/**
 * PanelGuard — el panel rápido (pausa / skip / etc.) SIEMPRE debe estar usable.
 *
 * El panel se pinta por eventos (playSong, finishSong, disconnect…). Si uno de
 * esos eventos se pierde o llega fuera de orden (reconexión de voz, lag del
 * proceso, un edit que falla), el panel puede quedar:
 *   - DESHABILITADO ("SONG & QUEUE ENDED") mientras el bot suena, o
 *   - HABILITADO sin que suene nada, o
 *   - BORRADO.
 * y nada lo corregía hasta el siguiente cambio de canción.
 *
 * Este vigilante revisa cada pocos segundos el estado REAL (cola viva vs. botones
 * del mensaje) y corrige. No lee la base de datos: usa `client._panelRef` (que
 * actualizan updateplayer/updateembed) y la caché de mensajes de discord.js, y
 * solo hace una petición REST por guild una vez por minuto para detectar un
 * panel borrado.
 */
"use strict";

const CHECK_MS = Math.max(3000, Number(process.env.PANEL_GUARD_MS) || 8000);
const REST_CHECK_MS = 60000;
const MIN_GAP_MS = 10000; // entre dos correcciones del mismo guild

module.exports = (client) => {
  const lastFix = new Map(); // guildId -> ts
  const lastRest = new Map(); // guildId -> ts
  const suspect = new Map(); // guildId -> nº de revisiones seguidas con el estado "idle incoherente"

  const pauseBtn = (msg) => {
    try {
      for (const row of msg?.components || []) {
        for (const c of row?.components || []) {
          if (c?.customId === "pauseresume") return c;
        }
      }
    } catch {}
    return null;
  };

  const check = async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const gid = guild.id;
        const ref = client._panelRef?.get(gid);
        if (!ref?.channelId || !ref.pmsg) continue;
        const now = Date.now();
        if (now - (lastFix.get(gid) || 0) < MIN_GAP_MS) continue;

        const q = client.distube?.getQueue?.(gid);
        const live = !!q?.songs?.length;
        const recovering = !!client._voiceRecovering?.get(gid);

        const channel = guild.channels.cache.get(ref.channelId);
        if (!channel?.messages) continue;

        // Mensaje desde la caché (sin REST). Si no está cacheado, 1 fetch/min.
        let msg = channel.messages.cache.get(ref.pmsg);
        if (!msg && now - (lastRest.get(gid) || 0) > REST_CHECK_MS) {
          lastRest.set(gid, now);
          msg = await client.fetchPanelMessage?.(channel, ref.pmsg);
          if (msg === null) {
            // Discord confirmó que NO existe: Self-Repair lo recrea (y, con cola
            // viva, lo repinta).
            lastFix.set(gid, now);
            client.logger?.warn?.(`[PanelGuard] G:${gid} el panel no existe: se recrea.`);
            client.updateembed?.(client, guild)?.catch?.(() => {});
            continue;
          }
        }
        if (!msg) continue;

        const btn = pauseBtn(msg);
        if (!btn) continue; // panel sin botones de control (p. ej. el flotante): no aplica
        const disabled = !!btn.disabled;
        const footer = String(msg.embeds?.[0]?.footer?.text || "");
        const looksEnded = disabled || /ENDED/i.test(footer);

        if (live && looksEnded) {
          // Cola viva pero el panel está muerto → repintar. Se espera a que no haya
          // un rescate de voz en curso para no pelear con él.
          if (recovering) continue;
          lastFix.set(gid, now);
          suspect.delete(gid);
          client.logger?.warn?.(`[PanelGuard] G:${gid} cola viva con el panel deshabilitado: repintando.`);
          client.forcePanelRefresh?.(gid, "PanelGuard");
        } else if (!live && !looksEnded && !recovering) {
          // Sin cola pero el panel sigue con botones activos. Se exige que se
          // repita 2 revisiones seguidas (la cola puede estar rearmándose).
          const n = (suspect.get(gid) || 0) + 1;
          suspect.set(gid, n);
          if (n >= 2) {
            suspect.delete(gid);
            lastFix.set(gid, now);
            client.logger?.warn?.(`[PanelGuard] G:${gid} sin cola pero el panel sigue activo: se deja en reposo.`);
            client._playerPanel?.delete(gid);
            client.updateembed?.(client, guild)?.catch?.(() => {});
          }
        } else {
          suspect.delete(gid);
        }
      } catch (_) { /* nunca romper el intervalo */ }
    }
  };

  const t = setInterval(() => { check().catch(() => {}); }, CHECK_MS);
  if (typeof t.unref === "function") t.unref();
  client._panelGuardTimer = t;
};
