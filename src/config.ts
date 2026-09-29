// All settings in one place. Read from the .env file.
import 'dotenv/config';
import type { Mode } from './types.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env file. Did you copy .env.example to .env?`);
  return value;
}

function readMode(): Mode {
  const mode = process.env.MODE ?? 'distributed';
  if (mode !== 'single' && mode !== 'distributed') {
    throw new Error(`MODE must be "single" or "distributed", got "${mode}"`);
  }
  return mode;
}

export const config = {
  mode: readMode(),
  port: Number(process.env.PORT) || 3000,
  reportIntervalMs: (Number(process.env.REPORT_INTERVAL_SECONDS) || 60) * 1000,
  allowedHttpHosts: (process.env.ALLOWED_HTTP_HOSTS ?? 'localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),

  // Read only when needed (e.g. single mode never asks for REDIS_URL).
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  get adminDatabaseUrl(): string {
    return required('ADMIN_DATABASE_URL');
  },
  get redisUrl(): string {
    return required('REDIS_URL');
  },
};
