import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import pg from 'pg';

// ERTAD-only disposable database. No real member/admin records or credentials are copied.
loadEnvFile('.env');
const database = `ertad_scope_test_${randomBytes(8).toString('hex')}`;
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(process.env.POSTGRES_PASSWORD && process.env.APP_DB_PASSWORD);
const config = { host: '127.0.0.1', port, user: 'ertad_owner', password: process.env.POSTGRES_PASSWORD,
  connectionTimeoutMillis: 3000, statement_timeout: 15000 };
const control = new pg.Client({ ...config, database: 'ertad' });
const owner = new pg.Client({ ...config, database, options: '-c search_path=ertad,public' });
const blocker = new pg.Client({ ...config, database, options: '-c search_path=ertad,public' });
const writer = new pg.Client({ ...config, database, options: '-c search_path=ertad,public' });
const connected: pg.Client[] = [];
let created = false;
let closeRuntime: (() => Promise<void>) | undefined;
let checks = 0;
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;
const migrationEnv = { ...process.env,
  MIGRATION_DATABASE_URL: `postgresql://ertad_owner:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:${port}/${database}` };
const check = async (name: string, action: () => Promise<void>) => {
  await action(); checks++; console.log(`PASS ${name}`);
};
const sqlDenied = (sql: string, args: unknown[] = [], code = '23514') =>
  assert.rejects(owner.query(sql, args), (e: any) => e.code === code);
const hash = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const ids = Object.fromEntries(['account', 'member', 'session', 'org', 'otherOrg', 'root', 'local', 'professional',
  'otherRoot', 'bundle', 'position', 'membership'].map(key => [key, randomUUID()]));
const session = { sessionId: ids.session, sessionTokenHash: hash() };

// Wait on actual PostgreSQL lock state, not an assumed scheduling delay.
async function waitForBlockedBy(pid: number): Promise<number> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const result = await control.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = $1 AND $2 = ANY(pg_blocking_pids(pid))`, [database, pid]);
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Expected database lock wait was not observed');
}

await control.connect();
try {
  await control.query(`CREATE DATABASE ${database}`);
  created = true;
  const migrated = execFileSync(process.execPath, ['--import', 'tsx', 'backend/src/migrate.ts'], { env: migrationEnv, encoding: 'utf8' });
  assert.match(migrated, /Applied 0003_scoped_membership.sql/);
  assert.equal(execFileSync(process.execPath, ['--import', 'tsx', 'backend/src/migrate.ts'], { env: migrationEnv, encoding: 'utf8' }).trim(), '');
  for (const client of [owner, blocker, writer]) { await client.connect(); connected.push(client); }
  const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  const { pool, close } = await import('../backend/src/db/client.ts');
  closeRuntime = close;
  const { readUnitForWebSession, ScopedAccessDenied } = await import('../backend/src/modules/organization/readUnit.ts');
  const read = () => readUnitForWebSession(session, ids.org, ids.local);
  const auditCount = async () => Number((await owner.query('SELECT count(*) FROM audit_log')).rows[0].count);
  const deniedRead = async (action = read) => {
    const count = await auditCount();
    await assert.rejects(action(), ScopedAccessDenied);
    assert.equal(await auditCount(), count);
  };
  await owner.query(`INSERT INTO admin_users (id, email, password_hash, role, mfa_secret_encrypted)
    VALUES ($1, 'synthetic@example.invalid', 'synthetic-non-login-hash', 'observer', 'v2:synthetic')`, [ids.account]);
  await owner.query(`INSERT INTO admin_sessions (id, admin_user_id, token_hash, csrf_token_hash, csrf_token_encrypted,
    idle_expires_at, absolute_expires_at) VALUES ($1, $2, $3, $4, 'v2:synthetic', now() + interval '1 hour', now() + interval '2 hours')`,
  [ids.session, ids.account, session.sessionTokenHash, hash()]);
  await owner.query('INSERT INTO member_users (id, web_account_id) VALUES ($1, $2)', [ids.member, ids.account]);
  await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'Synthetic A'), ($2, 'Synthetic B')", [ids.org, ids.otherOrg]);
  await owner.query(`INSERT INTO units (organization_id, id, parent_id, name, kind) VALUES
    ($1, $2, NULL, 'Synthetic root', 'authority'), ($3, $4, NULL, 'Other root', 'authority')`,
  [ids.org, ids.root, ids.otherOrg, ids.otherRoot]);
  await owner.query(`INSERT INTO units (organization_id, id, parent_id, name, kind) VALUES
    ($1, $2, $3, 'Synthetic local', 'authority'), ($1, $4, $3, 'Synthetic professional', 'professional')`,
  [ids.org, ids.local, ids.root, ids.professional]);
  await owner.query('INSERT INTO permission_bundles (organization_id, id, version) VALUES ($1, $2, 1)', [ids.org, ids.bundle]);
  await owner.query("INSERT INTO permission_grants VALUES ($1, $2, 1, 'unit.read', 'subtree')", [ids.org, ids.bundle]);
  await owner.query("UPDATE permission_bundles SET status = 'approved' WHERE organization_id = $1", [ids.org]);
  await owner.query(`INSERT INTO positions (organization_id, id, unit_id, name, bundle_id, bundle_version)
    VALUES ($1, $2, $3, 'Synthetic position', $4, 1)`, [ids.org, ids.position, ids.root, ids.bundle]);
  await owner.query(`INSERT INTO memberships (organization_id, id, user_id, unit_id, position_id, bundle_version, valid_from)
    VALUES ($1, $2, $3, $4, $5, 1, now() - interval '1 minute')`,
  [ids.org, ids.membership, ids.member, ids.root, ids.position]);

  await check('additive migrations apply once and verify checksums on rerun', async () => {
    assert.equal((await owner.query('SELECT count(*) FROM schema_migrations')).rows[0].count,
      String((migrated.match(/^Applied /gm) ?? []).length));
  });
  await check('scoped read uses persisted authority, projects no member directory and audits atomically', async () => {
    assert.deepEqual(await read(), { id: ids.local, organizationId: ids.org, parentId: ids.root,
      name: 'Synthetic local', kind: 'authority' });
    const event = (await owner.query("SELECT * FROM audit_log WHERE event_type = 'UNIT_READ'")).rows[0];
    assert.deepEqual(JSON.parse(event.payload), { organizationId: ids.org, unitId: ids.local, userId: ids.member,
      membershipId: ids.membership, bundleId: ids.bundle, bundleVersion: 1 });
    assert.ok(!event.payload.includes(session.sessionTokenHash));
  });
  await check('wrong organization, unknown resource, forged session and JWT-like input deny without audit success', async () => {
    await deniedRead(() => readUnitForWebSession(session, ids.otherOrg, ids.local));
    await deniedRead(() => readUnitForWebSession(session, ids.org, randomUUID()));
    await deniedRead(() => readUnitForWebSession({ ...session, sessionTokenHash: hash() }, ids.org, ids.local));
    await deniedRead(() => readUnitForWebSession({ ...session, sessionId: randomUUID() }, ids.org, ids.local));
    await deniedRead(() => readUnitForWebSession({ ...session, sessionTokenHash: 'synthetic.member.jwt' }, ids.org, ids.local));
  });
  await check('superadmin name cannot replace an explicit member identity', async () => {
    await owner.query("UPDATE admin_users SET role = 'superadmin' WHERE id = $1", [ids.account]);
    await owner.query('UPDATE member_users SET web_account_id = NULL WHERE id = $1', [ids.member]);
    await deniedRead();
    await owner.query('UPDATE member_users SET web_account_id = $1 WHERE id = $2', [ids.account, ids.member]);
    await owner.query("UPDATE admin_users SET role = 'observer' WHERE id = $1", [ids.account]);
  });
  for (const [name, invalidate, restore] of [
    ['session revocation', "UPDATE admin_sessions SET revoked_at = now()", 'UPDATE admin_sessions SET revoked_at = NULL'],
    ['session expiry', "UPDATE admin_sessions SET idle_expires_at = now() - interval '1 second'", "UPDATE admin_sessions SET idle_expires_at = now() + interval '1 hour'"],
    ['account suspension', 'UPDATE admin_users SET is_active = false', 'UPDATE admin_users SET is_active = true'],
    ['account lockout', "UPDATE admin_users SET locked_until = now() + interval '1 minute'", 'UPDATE admin_users SET locked_until = NULL'],
    ['member suspension', "UPDATE member_users SET status = 'suspended'", "UPDATE member_users SET status = 'active'"],
    ['organization suspension', "UPDATE organizations SET status = 'suspended'", "UPDATE organizations SET status = 'active'"],
    ['membership suspension', "UPDATE memberships SET status = 'suspended'", "UPDATE memberships SET status = 'active'"],
    ['membership expiry', "UPDATE memberships SET valid_until = now() - interval '1 second'", 'UPDATE memberships SET valid_until = NULL'],
    ['future membership', "UPDATE memberships SET valid_from = now() + interval '1 minute'", "UPDATE memberships SET valid_from = now() - interval '1 minute'"],
    ['position retirement', "UPDATE positions SET status = 'retired'", "UPDATE positions SET status = 'active'"],
    ['archived ancestor', "UPDATE units SET status = 'archived' WHERE parent_id IS NULL", "UPDATE units SET status = 'active'"],
  ]) {
    await check(`${name} is revalidated from the database`, async () => {
      await owner.query(invalidate); await deniedRead(); await owner.query(restore);
    });
  }
  await check('runtime cannot grant authority, remap identity, rewrite audit or bypass tenant schema', async () => {
    for (const sql of ["UPDATE member_users SET status = 'active'", "INSERT INTO organizations(name) VALUES ('Forbidden')",
      "UPDATE memberships SET status = 'active'", 'DELETE FROM permission_grants', "UPDATE permission_bundles SET status = 'approved'",
      'UPDATE positions SET bundle_version = 1', 'UPDATE units SET parent_id = NULL', 'TRUNCATE memberships',
      'DELETE FROM audit_log', 'SET ROLE ertad_owner', 'CREATE TABLE ertad.forbidden_probe(id int)']) {
      await assert.rejects(pool.query(sql), (e: any) => e.code === '42501');
    }
    const helper = (await owner.query(`SELECT proconfig, EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner)))
        WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc WHERE oid = 'ertad.lock_web_authority(uuid,text,uuid)'::regprocedure`)).rows[0];
    assert.equal(helper.public_execute, false);
    assert.deepEqual(helper.proconfig, ['search_path=pg_catalog']);
  });
  await check('composite foreign keys reject cross-tenant parents, bundles and position links', async () => {
    await sqlDenied('UPDATE units SET parent_id = $1 WHERE organization_id = $2 AND id = $3', [ids.otherRoot, ids.org, ids.local], '23503');
    await sqlDenied('UPDATE positions SET unit_id = $1 WHERE organization_id = $2', [ids.otherRoot, ids.org], '23503');
    await sqlDenied('UPDATE memberships SET unit_id = $1 WHERE organization_id = $2', [ids.local, ids.org], '23503');
    await sqlDenied('UPDATE positions SET bundle_id = $1 WHERE organization_id = $2', [randomUUID(), ids.org], '23503');
    await sqlDenied('UPDATE units SET organization_id = $1 WHERE organization_id = $2', [ids.otherOrg, ids.org]);
  });
  await check('hierarchy rejects a second root, direct cycle and invalid membership intervals', async () => {
    await sqlDenied("INSERT INTO units (organization_id, name, kind) VALUES ($1, 'Second root', 'authority')", [ids.org], '23505');
    await sqlDenied('UPDATE units SET parent_id = $1 WHERE organization_id = $2 AND id = $3', [ids.local, ids.org, ids.root]);
    await sqlDenied("UPDATE memberships SET valid_until = valid_from");
    await sqlDenied("UPDATE memberships SET valid_from = '-infinity'");
  });
  await check('professional branch cannot confer authority over a sibling unit', async () => {
    const position = randomUUID();
    await owner.query(`INSERT INTO positions (organization_id, id, unit_id, name, bundle_id, bundle_version)
      VALUES ($1, $2, $3, 'Professional reviewer', $4, 1)`, [ids.org, position, ids.professional, ids.bundle]);
    await owner.query('UPDATE memberships SET unit_id = $1, position_id = $2', [ids.professional, position]);
    await deniedRead();
    await owner.query('UPDATE memberships SET unit_id = $1, position_id = $2', [ids.root, ids.position]);
  });
  await check('published grant content and version cannot be edited or reopened', async () => {
    await sqlDenied("UPDATE permission_grants SET scope = 'unit'");
    await sqlDenied('DELETE FROM permission_grants');
    await sqlDenied("INSERT INTO permission_grants VALUES ($1, $2, 1, 'workitem.create', 'subtree')", [ids.org, ids.bundle]);
    await sqlDenied("UPDATE permission_bundles SET status = 'draft'");
    await sqlDenied('UPDATE permission_bundles SET version = 2');
  });
  await check('audit storage failure returns no projection and commits no success event', async () => {
    const before = await auditCount();
    await owner.query('REVOKE INSERT ON audit_log FROM ertad_app');
    try { await assert.rejects(read(), (e: any) => e.code === '42501'); }
    finally { await owner.query('GRANT INSERT ON audit_log TO ertad_app'); }
    assert.equal(await auditCount(), before);
  });
  await check('a reader waiting behind revocation sees the committed revoked membership', async () => {
    await blocker.query('BEGIN');
    await blocker.query("UPDATE memberships SET status = 'ended'");
    const denied = assert.rejects(read(), ScopedAccessDenied);
    await waitForBlockedBy(blockerPid);
    await blocker.query('COMMIT');
    await denied;
    await owner.query("UPDATE memberships SET status = 'active'");
  });
  await check('revocation waits for an authorized read and its audit to finish', async () => {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(752991884322001::bigint)');
    const pendingRead = read();
    const readerPid = await waitForBlockedBy(blockerPid);
    await writer.query('BEGIN');
    const revoke = writer.query("UPDATE memberships SET status = 'suspended'");
    await waitForBlockedBy(readerPid);
    await blocker.query('COMMIT');
    assert.equal((await pendingRead).id, ids.local);
    await revoke; await writer.query('COMMIT');
    await deniedRead();
    await owner.query("UPDATE memberships SET status = 'active'");
  });
  await check('expiry while waiting for audit rolls back the provisional event', async () => {
    await owner.query("UPDATE memberships SET valid_until = clock_timestamp() + interval '5 seconds'");
    const before = await auditCount();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(752991884322001::bigint)');
    const pending = assert.rejects(read(), ScopedAccessDenied);
    await waitForBlockedBy(blockerPid);
    await owner.query('SELECT pg_sleep(GREATEST(0, extract(epoch FROM max(valid_until) - clock_timestamp())) + 0.02) FROM memberships');
    await blocker.query('COMMIT');
    await pending;
    assert.equal(await auditCount(), before);
    await owner.query('UPDATE memberships SET valid_until = NULL');
  });
  for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
    await check(`concurrent reparenting cannot create a cycle at ${isolation}`, async () => {
      await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await writer.query('SELECT authority_revision FROM organizations');
      await blocker.query('BEGIN');
      await blocker.query('UPDATE units SET parent_id = $1 WHERE organization_id = $2 AND id = $3', [ids.professional, ids.org, ids.local]);
      const second = writer.query('UPDATE units SET parent_id = $1 WHERE organization_id = $2 AND id = $3',
        [ids.local, ids.org, ids.professional]).then(() => 'unexpected-success', (e: any) => e.code);
      await waitForBlockedBy(blockerPid);
      await blocker.query('COMMIT');
      assert.equal(await second, isolation === 'READ COMMITTED' ? '23514' : '40001');
      await writer.query('ROLLBACK');
      await owner.query('UPDATE units SET parent_id = $1 WHERE organization_id = $2 AND id = $3', [ids.root, ids.org, ids.local]);
    });
  }
  await check('version changes require the membership to match the new approved bundle', async () => {
    await owner.query('INSERT INTO permission_bundles (organization_id, id, version) VALUES ($1, $2, 2)', [ids.org, ids.bundle]);
    await owner.query("INSERT INTO permission_grants VALUES ($1, $2, 2, 'unit.read', 'subtree')", [ids.org, ids.bundle]);
    await owner.query('UPDATE positions SET bundle_version = 2');
    await owner.query('UPDATE memberships SET bundle_version = 2');
    await deniedRead(); // Draft bundle cannot grant authority.
    await owner.query("UPDATE permission_bundles SET status = 'approved' WHERE version = 2");
    assert.equal((await read()).id, ids.local);
    await owner.query('UPDATE memberships SET bundle_version = 1');
    await deniedRead();
    await owner.query('UPDATE memberships SET bundle_version = 2');
    assert.ok((await Promise.all([read(), read(), read()])).every(unit => unit.id === ids.local));
  });
  await check('revoked bundles cannot be reused or reactivate a permission', async () => {
    await owner.query("UPDATE permission_bundles SET status = 'revoked' WHERE version = 2");
    await deniedRead();
    await sqlDenied("UPDATE permission_bundles SET status = 'approved' WHERE version = 2");
  });
  await check('concurrent read audits preserve a single hash chain with minimal payloads', async () => {
    let previous = '0'.repeat(64);
    for (const event of (await owner.query('SELECT * FROM audit_log ORDER BY id')).rows) {
      assert.equal(event.previous_hash, previous);
      assert.equal(event.row_hash, createHash('sha256').update(`${event.event_type}|${event.payload}|${previous}|${event.created_at}`).digest('hex'));
      assert.ok(Object.keys(JSON.parse(event.payload)).every(key =>
        ['organizationId', 'unitId', 'userId', 'membershipId', 'bundleId', 'bundleVersion'].includes(key)));
      previous = event.row_hash;
    }
  });
  console.log(`PASS ${checks} scoped database scenarios; synthetic scratch database will be removed`);
} finally {
  // Release blockers before closing the runtime pool if an assertion failed mid-race.
  for (const client of [blocker, writer]) {
    if (connected.includes(client)) await client.query('ROLLBACK').catch(() => {});
  }
  if (closeRuntime) await closeRuntime();
  for (const client of connected) await client.end();
  if (!/^ertad_scope_test_[a-f0-9]{16}$/.test(database)) throw new Error('Invalid scratch database target');
  if (created) await control.query(`DROP DATABASE ${database}`);
  await control.end();
}
