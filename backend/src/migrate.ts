import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL required');
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock(42420001)');
  await client.query('CREATE SCHEMA IF NOT EXISTS ertad');
  await client.query('CREATE TABLE IF NOT EXISTS ertad.schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const version of (await readdir(dir)).filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort()) {
    const sql = await readFile(new URL(version, dir), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('SELECT checksum FROM ertad.schema_migrations WHERE version = $1', [version]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${version}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO ertad.schema_migrations(version,checksum) VALUES ($1,$2)', [version, checksum]);
      await client.query('COMMIT');
      console.log(`Applied ${version}`);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
} finally { await client.end(); }
