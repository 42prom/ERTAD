import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const suffix = randomBytes(8).toString('hex');
const database = `ertad_restore_${suffix}`;
const dump = `/tmp/${database}.dump`;
const run = (...args) => execFileSync('docker', ['compose', 'exec', '-T', 'postgres', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const query = (db, sql) => run('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'ertad_owner', '-d', db, '-Atc', sql);
let created = false;
try {
  const before = query('ertad', 'SELECT version || checksum FROM ertad.schema_migrations ORDER BY version');
  run('pg_dump', '-U', 'ertad_owner', '-d', 'ertad', '-Fc', '-f', dump);
  run('createdb', '-U', 'ertad_owner', database);
  created = true;
  run('pg_restore', '-U', 'ertad_owner', '-d', database, '--exit-on-error', dump);
  assert.equal(query(database, 'SELECT version || checksum FROM ertad.schema_migrations ORDER BY version'), before);
  console.log('PASS local dump/restore into a new temporary database; migration checksums preserved');
} finally {
  // Only this invocation's random scratch database/file can be removed.
  if (!/^ertad_restore_[a-f0-9]{16}$/.test(database) || dump !== `/tmp/${database}.dump`) throw new Error('Invalid scratch target');
  if (created) run('dropdb', '-U', 'ertad_owner', database);
  run('rm', '-f', dump);
}
