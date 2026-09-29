// Picks the runtime from MODE. The rest of the app only uses the
// interfaces (JobQueue, EventBus, Lock, Counter) and never cares which one.
import { config } from '../config.js';
import type { Runtime } from '../types.js';
import { createMemoryRuntime } from './memory.js';
import { createRedisRuntime } from './redis.js';

let runtime: Runtime | undefined;

export function getRuntime(): Runtime {
  if (!runtime) runtime = config.mode === 'single' ? createMemoryRuntime() : createRedisRuntime();
  return runtime;
}
