// Structured logging (pino).
// LOG_FORMAT=pretty -> colored, easy to read (default)
// LOG_FORMAT=json   -> one JSON object per line (for log tools, CI, tests)
import 'dotenv/config';
import { destination, pino, type Logger } from 'pino';
import { PinoPretty } from 'pino-pretty';

const stream =
  process.env.LOG_FORMAT === 'json'
        ? destination({ dest: 1, sync: true })
    : PinoPretty({ colorize: true, sync: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' });

const rootLogger = pino({ level: process.env.LOG_LEVEL || 'info' }, stream);

export type { Logger };

// Every log line gets fields like { service: "worker", instance: "A" }.
export function createLogger(fields: Record<string, unknown>): Logger {
  return rootLogger.child(fields);
}
