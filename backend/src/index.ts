import pg from 'pg';
import { createClient } from 'redis';
import pino from 'pino';
import { createApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const logger = pino({ level: 'info' });
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 1500, query_timeout: 1500, statement_timeout: 1500 });
pool.on('error', () => logger.error({ dependency: 'postgres' }, 'dependency unavailable'));
const redis = createClient({ url: config.redisUrl, disableOfflineQueue: true, socket: { connectTimeout: 1500, reconnectStrategy: retries => Math.min(retries * 200, 3000) } });
redis.on('error', () => logger.warn({ dependency: 'redis' }, 'dependency unavailable'));
void redis.connect().catch(() => logger.error({ dependency: 'redis' }, 'connection failed'));
const app = createApp({
  postgres: async () => {
    const result = await pool.query("SELECT version FROM ertad.schema_migrations WHERE version = '0001_foundation.sql'");
    if (result.rowCount !== 1) throw new Error('Schema not ready');
  },
  redis: async () => { if (await redis.ping() !== 'PONG') throw new Error('Redis unavailable'); },
  storage: async () => {
    const result = await fetch(config.storageHealthUrl, { signal: AbortSignal.timeout(1500) });
    if (!result.ok) throw new Error('Storage unavailable');
  },
}, logger, config.webOrigin);
const server = app.listen(config.port, config.host, (error?: Error) => {
  if (error) { logger.error('API could not bind configured address'); process.exit(1); }
  logger.info({ port: config.port }, 'ERTAD foundation listening');
});
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => {
    void Promise.allSettled([pool.end(), Promise.resolve().then(() => { if (redis.isOpen) redis.destroy(); })])
      .then(() => { clearTimeout(deadline); process.exit(0); });
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
