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

client.on(Events.ShardReady, async (shardId) => {
  try {
    client.logger.log(`[ShardReady] Shard ${shardId} ready, checking for queues to restore...`);
    await AutoresumeHandler(client);
  } catch (error) {
    client.logger.error(`[ShardReady Error] Shard ${shardId}:`, error);
  }
});
