import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import assert from 'node:assert/strict';
import pg from 'pg';

loadEnvFile('.env');
assert.notEqual(process.env.NODE_ENV, 'production', 'This drill is local development only');
const database = 'ertad_restore_' + randomBytes(8).toString('hex');
const dump = '/tmp/' + database + '.dump';
const run = (...args) => execFileSync('docker', ['compose', 'exec', '-T', 'postgres', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
}).trim();
const connection = {
  host: '127.0.0.1', port: Number(process.env.ERTAD_POSTGRES_PORT ?? 15432),
  user: 'ertad_owner', password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: 5000, statement_timeout: 120_000,
};
const source = new pg.Client({ ...connection, database: 'ertad' });
const restored = new pg.Client({ ...connection, database });
let created = false;
const started = performance.now();
function identifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}
async function manifest(client) {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='ertad' ORDER BY tablename")).rows;
  const rows = [];
  for (const { tablename } of tables) {
    // Compare all rows including ciphertext, without logging or returning any record content.
    const result = await client.query('SELECT count(*)::text AS count, md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) ORDER BY to_jsonb(t)::text),\'\')) AS digest FROM ertad.' + identifier(tablename) + ' t');
    rows.push({ table: tablename, ...result.rows[0] });
  }
  const privileges = (await client.query(
    "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege('ertad_app',c.oid,'SELECT') AS read,has_table_privilege('ertad_app',c.oid,'INSERT') AS insert,has_table_privilege('ertad_app',c.oid,'UPDATE') AS update,has_table_privilege('ertad_app',c.oid,'DELETE') AS delete FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ertad' AND c.relkind IN ('r','p') ORDER BY c.relname"
  )).rows;
  const functions = (await client.query(
    "SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,p.prosecdef,p.proconfig,has_function_privilege('ertad_app',p.oid,'EXECUTE') AS execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ertad' ORDER BY p.proname,arguments"
  )).rows;
  return { rows, privileges, functions };
}
try {
  await source.connect();
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot = (await source.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const before = await manifest(source);
  run('pg_dump', '-U', 'ertad_owner', '-d', 'ertad', '--snapshot=' + snapshot, '-Fc', '-f', dump);
  await source.query('COMMIT');
  run('createdb', '-U', 'ertad_owner', database);
  created = true;
  run('pg_restore', '-U', 'ertad_owner', '-d', database, '--exit-on-error', dump);
  await restored.connect();
  const after = await manifest(restored);
  assert(JSON.stringify(before) === JSON.stringify(after), 'Restored records, runtime privileges or function protections differ');
  const migrations = Number((await restored.query('SELECT count(*) FROM ertad.schema_migrations')).rows[0].count);
  assert(migrations > 0, 'Migration history missing');
  // A failed protected write must be rejected by PostgreSQL itself after restoration.
  await restored.query('BEGIN');
  try {
    await restored.query('SET LOCAL ROLE ertad_app');
    await assert.rejects(restored.query('DELETE FROM ertad.audit_log WHERE false'), { code: '42501' });
  } finally {
    await restored.query('ROLLBACK');
  }
  // Prove the content check detects corruption, touching only the disposable clone.
  await restored.query('BEGIN');
  try {
    await restored.query("UPDATE ertad.schema_migrations SET checksum=repeat('0',64) WHERE version=(SELECT min(version) FROM ertad.schema_migrations)");
    const damaged = await manifest(restored);
    assert(JSON.stringify(after) !== JSON.stringify(damaged), 'Content mismatch was not detected');
  } finally {
    await restored.query('ROLLBACK');
  }
  assert(JSON.stringify(after) === JSON.stringify(await manifest(restored)), 'Negative probe did not roll back');
  console.log('PASS consistent local restore: ' + after.rows.length + ' tables, ' + migrations + ' migrations, runtime ACL/RLS/function protections, denied audit writes and corruption detection (' + ((performance.now() - started) / 1000).toFixed(1) + 's)');
} finally {
  await Promise.allSettled([source.end(), restored.end()]);
  // Only this invocation's random scratch database and exact container file are disposable.
  if (!/^ertad_restore_[a-f0-9]{16}$/.test(database) || dump !== '/tmp/' + database + '.dump') throw new Error('Invalid scratch target');
  try {
    if (created) run('dropdb', '-U', 'ertad_owner', database);
  } finally {
    run('rm', '-f', '--', dump);
  }
}
