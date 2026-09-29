// Redis connection. Created only when first needed,
// so MODE=single never connects to Redis.
import { Redis } from 'ioredis';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger({ service: 'redis' });
let client: Redis | undefined;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }); // fail fast
    client.on('error', (err) => log.error({ err: err.message }, 'redis error'));
  }
  return client;
}

export async function checkRedis(): Promise<void> {
  await getRedis().ping();
}

export function closeRedis(): void {
  client?.disconnect();
  client = undefined;
}
