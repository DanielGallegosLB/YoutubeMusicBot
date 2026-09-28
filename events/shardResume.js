const { Events } = require("discord.js");
const client = require("../index");
const AutoresumeHandler = require("../handlers/AutoresumeHandler");

client.on(Events.ShardResume, async (shardId, replayedEvents) => {
  try {
    client.logger.log(`[ShardResume] Shard ${shardId} resumed (${replayedEvents} events replayed), restoring queues...`);
    await AutoresumeHandler(client);
  } catch (error) {
    client.logger.error(`[ShardResume Error] Shard ${shardId}:`, error);
  }
});

// OJO: en un ARRANQUE EN FRÍO (ShardReady tras reiniciar el proceso) NO se
// restaura ninguna cola. Reanudar música que quedó guardada hace que el bot
// "empiece a reproducir algo que el usuario no pidió" después de reiniciar.
// La auto-reanudación queda solo para ShardResume (reconexión de la misma sesión).
client.on(Events.ShardReady, async (shardId) => {
  try {
    client.logger.log(`[ShardReady] Shard ${shardId} ready (fresh start: auto-resume disabled).`);
  } catch (error) {
    client.logger.error(`[ShardReady Error] Shard ${shardId}:`, error);
  }
});
