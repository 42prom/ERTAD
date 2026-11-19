import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import type { BootstrapPlan, GovernanceBootstrap } from '../backend/src/modules/governance/bootstrap.ts';

loadEnvFile('.env');
process.env.NODE_ENV = 'test';
process.env.ERTAD_BOOTSTRAP_MODE = 'true';
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(process.env.POSTGRES_PASSWORD && process.env.APP_DB_PASSWORD);
const config = { host: '127.0.0.1', port, user: 'ertad_owner', password: process.env.POSTGRES_PASSWORD,
  options: '-c search_path=ertad,public', connectionTimeoutMillis: 3000, statement_timeout: 15000 };
const control = new pg.Client({ ...config, database: 'ertad' });
let implementation: typeof import('../backend/src/modules/governance/bootstrap.ts') | undefined;
let closeRuntime: (() => Promise<void>) | undefined;
let checks = 0;
const check = async (name: string, action: () => Promise<void>) => { await action(); checks++; console.log(`PASS ${name}`); };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type Fixture = { database: string; owner: pg.Pool; runtime: pg.Pool; service: GovernanceBootstrap;
  plan: BootstrapPlan; tokens: string[]; accounts: string[]; sessions: string[] };

async function fixture(action: (f: Fixture) => Promise<void>) {
  const database = `ertad_bootstrap_test_${randomBytes(8).toString('hex')}`;
  const owner = new pg.Pool({ ...config, database, max: 5 });
  const runtime = new pg.Pool({ ...config, database, user: 'ertad_app', password: process.env.APP_DB_PASSWORD });
  let created = false;
  try {
    await control.query(`CREATE DATABASE ${database}`); created = true;
    const url = `postgresql://ertad_owner:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:${port}/${database}`;
    execFileSync(process.execPath, ['--import', 'tsx', 'backend/src/migrate.ts'], { env: { ...process.env, MIGRATION_DATABASE_URL: url }, encoding: 'utf8' });
    process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;
    if (!implementation) {
      implementation = await import('../backend/src/modules/governance/bootstrap.ts');
      closeRuntime = (await import('../backend/src/db/client.ts')).close;
    }
    const accounts = [randomUUID(), randomUUID(), randomUUID()];
    const sessions = [randomUUID(), randomUUID(), randomUUID()];
    const tokens = accounts.map(() => randomBytes(32).toString('base64url'));
    for (let index = 0; index < accounts.length; index++) {
      await owner.query(`INSERT INTO admin_users(id, email, password_hash, role, mfa_secret_encrypted)
        VALUES ($1, $2, 'synthetic-non-login-hash', $3, 'v2:synthetic')`,
      [accounts[index], `synthetic-${index}@example.invalid`, index === 2 ? 'superadmin' : 'observer']);
      await owner.query(`INSERT INTO admin_sessions(id, admin_user_id, token_hash, csrf_token_hash, csrf_token_encrypted,
        idle_expires_at, absolute_expires_at, step_up_expires_at)
        VALUES ($1, $2, $3, $4, 'v2:synthetic', now() + interval '1 hour', now() + interval '2 hours', now() + interval '5 minutes')`,
      [sessions[index], accounts[index], hash(tokens[index]), hash('synthetic-csrf')]);
    }
    const plan = { id: randomUUID(), proposerAccountId: accounts[0], confirmerAccountId: accounts[1],
      organizationName: 'Synthetic organization', reason: 'Synthetic reviewed installation only' };
    await action({ database, owner, runtime, plan, accounts, sessions, tokens, service: new implementation.GovernanceBootstrap(owner) });
  } finally {
    if (closeRuntime) { await closeRuntime(); closeRuntime = undefined; }
    await runtime.end(); await owner.end();
    if (!/^ertad_bootstrap_test_[a-f0-9]{16}$/.test(database)) throw new Error('Invalid scratch target');
    if (created) await control.query(`DROP DATABASE ${database}`);
  }
}

async function failAudit(owner: pg.Pool, event: string) {
  // Failure injection is a real database trigger in this scratch database only.
  assert.match(event, /^[A-Z_]+$/);
  await owner.query(`CREATE FUNCTION ertad.synthetic_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type = '${event}' THEN RAISE EXCEPTION 'Synthetic audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON ertad.audit_log FOR EACH ROW EXECUTE FUNCTION ertad.synthetic_audit_failure()`);
}
async function restoreAudit(owner: pg.Pool) {
  await owner.query('DROP TRIGGER synthetic_audit_failure ON ertad.audit_log; DROP FUNCTION ertad.synthetic_audit_failure()');
}
async function noDomain(owner: pg.Pool) {
  const row = (await owner.query('SELECT (SELECT count(*) FROM member_users)::int AS users, (SELECT count(*) FROM organizations)::int AS orgs')).rows[0];
  assert.deepEqual(row, { users: 0, orgs: 0 });
}

await control.connect();
try {
  await fixture(async f => {
    const { service, owner, runtime, plan, accounts, sessions, tokens } = f;
    const denied = (action: () => Promise<unknown>) => assert.rejects(action, implementation!.BootstrapDenied);
    await check('bootstrap requires explicit offline mode and rejects production before touching the database', async () => {
      delete process.env.ERTAD_BOOTSTRAP_MODE;
      await denied(() => service.arm(plan));
      process.env.ERTAD_BOOTSTRAP_MODE = 'true'; process.env.NODE_ENV = 'production';
      await denied(() => service.arm(plan));
      process.env.NODE_ENV = 'test';
      await denied(() => new implementation!.GovernanceBootstrap(runtime).arm(plan));
      assert.equal((await owner.query('SELECT count(*) FROM governance_bootstrap')).rows[0].count, '0');
    });
    await check('same principal, missing account and invalid reason cannot arm a ceremony', async () => {
      await denied(() => service.arm({ ...plan, confirmerAccountId: plan.proposerAccountId }));
      await denied(() => service.arm({ ...plan, confirmerAccountId: randomUUID() }));
      await denied(() => service.arm({ ...plan, reason: 'short' }));
    });
    await check('existing member or organization makes the installation ineligible', async () => {
      const id = randomUUID();
      await owner.query('INSERT INTO member_users(id) VALUES ($1)', [id]);
      await denied(() => service.arm(plan));
      await owner.query('DELETE FROM member_users WHERE id = $1', [id]);
      await owner.query("INSERT INTO organizations(id, name) VALUES ($1, 'Synthetic existing')", [id]);
      await denied(() => service.arm(plan));
      await owner.query('DELETE FROM organizations WHERE id = $1', [id]);
    });
    await check('audit failure rolls back arming and permits a clean later attempt', async () => {
      await failAudit(owner, 'GOVERNANCE_BOOTSTRAP_ARMED');
      try { await assert.rejects(service.arm(plan), /Synthetic audit unavailable/); }
      finally { await restoreAudit(owner); }
      assert.equal((await owner.query('SELECT count(*) FROM governance_bootstrap')).rows[0].count, '0');
      assert.equal((await service.arm(plan)).status, 'armed');
      await noDomain(owner);
    });
    await check('arming cannot be repeated, rewritten or erased', async () => {
      await denied(() => service.arm(plan));
      for (const sql of ["UPDATE governance_bootstrap SET organization_name = 'Changed'", 'DELETE FROM governance_bootstrap', 'TRUNCATE governance_bootstrap, governance_bootstrap_events']) {
        await assert.rejects(owner.query(sql), (e: any) => e.code === '23514');
      }
    });
    await check('only the nominated proposer with a fresh web password step-up may endorse', async () => {
      for (const token of ['', 'synthetic.mobile.jwt', tokens[1], tokens[2]]) await denied(() => service.propose(plan.id, token));
      await owner.query('UPDATE admin_sessions SET step_up_expires_at = NULL WHERE id = $1', [sessions[0]]);
      await denied(() => service.propose(plan.id, tokens[0]));
      await owner.query("UPDATE admin_sessions SET step_up_expires_at = now() + interval '5 minutes' WHERE id = $1", [sessions[0]]);
      await failAudit(owner, 'GOVERNANCE_BOOTSTRAP_PROPOSED');
      try { await assert.rejects(service.propose(plan.id, tokens[0]), /Synthetic audit unavailable/); }
      finally { await restoreAudit(owner); }
      assert.equal((await owner.query('SELECT status FROM governance_bootstrap')).rows[0].status, 'armed');
      assert.equal((await service.propose(plan.id, tokens[0])).status, 'pending');
    });
    await check('a proposal grants nothing; retries do not duplicate endorsements', async () => {
      const before = (await owner.query('SELECT count(*) FROM audit_log')).rows[0].count;
      await service.propose(plan.id, tokens[0]);
      assert.equal((await owner.query('SELECT count(*) FROM audit_log')).rows[0].count, before);
      const event = (await owner.query("SELECT actor_account_id, recipient_account_id FROM governance_bootstrap_events WHERE action='proposed'")).rows[0];
      assert.deepEqual(event, { actor_account_id: accounts[0], recipient_account_id: accounts[1] });
      await noDomain(owner);
    });
    await check('requester cannot confirm or reject their own proposal; superadmin name cannot bypass nomination', async () => {
      await denied(() => service.decide(plan.id, tokens[0], 'confirm'));
      await denied(() => service.decide(plan.id, tokens[0], 'reject'));
      await denied(() => service.decide(plan.id, tokens[2], 'confirm'));
    });
    await check('revoked sessions, suspended accounts and stale endorsements block activation', async () => {
      for (const index of [0, 1]) {
        await owner.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1', [sessions[index]]);
        await denied(() => service.decide(plan.id, tokens[1], 'confirm'));
        await owner.query('UPDATE admin_sessions SET revoked_at = NULL WHERE id = $1', [sessions[index]]);
        await owner.query('UPDATE admin_users SET is_active = false WHERE id = $1', [accounts[index]]);
        await denied(() => service.decide(plan.id, tokens[1], 'confirm'));
        await owner.query('UPDATE admin_users SET is_active = true WHERE id = $1', [accounts[index]]);
        await owner.query("UPDATE admin_sessions SET step_up_expires_at = now() - interval '1 second' WHERE id = $1", [sessions[index]]);
        await denied(() => service.decide(plan.id, tokens[1], 'confirm'));
        await owner.query("UPDATE admin_sessions SET step_up_expires_at = now() + interval '5 minutes' WHERE id = $1", [sessions[index]]);
      }
      await noDomain(owner);
    });
    await check('finalization rechecks eligibility if another organization appeared after proposal', async () => {
      const id = randomUUID();
      await owner.query("INSERT INTO organizations(id, name) VALUES ($1, 'Synthetic competing')", [id]);
      await denied(() => service.decide(plan.id, tokens[1], 'confirm'));
      await owner.query('DELETE FROM organizations WHERE id = $1', [id]);
    });
    await check('audit failure rolls back both memberships, organization and terminal state', async () => {
      await failAudit(owner, 'GOVERNANCE_BOOTSTRAP_CONFIRMED');
      try { await assert.rejects(service.decide(plan.id, tokens[1], 'confirm'), /Synthetic audit unavailable/); }
      finally { await restoreAudit(owner); }
      await noDomain(owner);
      assert.equal((await owner.query('SELECT status FROM governance_bootstrap')).rows[0].status, 'pending');
      assert.equal((await owner.query("SELECT count(*) FROM governance_bootstrap_events WHERE action='confirmed'")).rows[0].count, '0');
    });
    await check('expiry during the audit wait rolls back the whole activation', async () => {
      const blocker = await owner.connect();
      try {
        await owner.query("UPDATE admin_sessions SET step_up_expires_at = clock_timestamp() + interval '5 seconds' WHERE id = $1", [sessions[0]]);
        await blocker.query('BEGIN');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await blocker.query('SELECT pg_advisory_xact_lock(752991884322001::bigint)');
        const pending = denied(() => service.decide(plan.id, tokens[1], 'confirm'));
        let waiting = false;
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline && !waiting) {
          waiting = (await control.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND $2 = ANY(pg_blocking_pids(pid))', [f.database, pid])).rowCount! > 0;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(waiting, 'Must observe the actual audit lock wait');
        await owner.query('SELECT pg_sleep(GREATEST(0, extract(epoch FROM step_up_expires_at-clock_timestamp())) + 0.02) FROM admin_sessions WHERE id=$1', [sessions[0]]);
        await blocker.query('COMMIT'); await pending;
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      await noDomain(owner);
      await owner.query("UPDATE admin_sessions SET step_up_expires_at=now()+interval '5 minutes' WHERE id=$1", [sessions[0]]);
    });
    await check('two concurrent confirmations produce one installation and one final endorsement', async () => {
      const results = await Promise.all([service.decide(plan.id, tokens[1], 'confirm'), service.decide(plan.id, tokens[1], 'confirm')]);
      assert.deepEqual(results[0], results[1]); assert.equal(results[0].status, 'completed');
      assert.equal((await owner.query('SELECT count(*) FROM organizations')).rows[0].count, '1');
      assert.equal((await owner.query('SELECT count(*) FROM member_users')).rows[0].count, '2');
      assert.equal((await owner.query('SELECT count(*) FROM memberships')).rows[0].count, '2');
      assert.equal((await owner.query("SELECT count(*) FROM governance_bootstrap_events WHERE action='confirmed'")).rows[0].count, '1');
      const permissions = (await owner.query('SELECT permission FROM permission_grants ORDER BY permission')).rows.map(row => row.permission);
      assert.deepEqual(permissions, ['membership.approve', 'membership.propose', 'unit.read', 'workitem.create', 'workitem.verify']);
    });
    await check('bootstrapped principals use the existing scoped read; unrelated administrator has no membership', async () => {
      const { readUnitForWebSession } = await import('../backend/src/modules/organization/readUnit.ts');
      const unit = (await owner.query('SELECT id, organization_id FROM units')).rows[0];
      for (const index of [0, 1]) {
        const result = await readUnitForWebSession({ sessionId: sessions[index], sessionTokenHash: hash(tokens[index]) }, unit.organization_id, unit.id);
        assert.equal(result.id, unit.id);
      }
      await assert.rejects(readUnitForWebSession({ sessionId: sessions[2], sessionTokenHash: hash(tokens[2]) }, unit.organization_id, unit.id));
    });
    await check('completion cannot be replayed as a new bootstrap or changed to rejection', async () => {
      await denied(() => service.arm({ ...plan, id: randomUUID() }));
      await denied(() => service.propose(plan.id, tokens[0]));
      await denied(() => service.decide(plan.id, tokens[1], 'reject'));
      await assert.rejects(owner.query("UPDATE governance_bootstrap SET status='armed'"));
    });
    await check('history is append-only; runtime cannot operate or rewrite the installer state', async () => {
      for (const sql of ['DELETE FROM governance_bootstrap_events', "UPDATE governance_bootstrap_events SET action='armed'", 'TRUNCATE governance_bootstrap_events']) {
        await assert.rejects(owner.query(sql));
      }
      for (const sql of ['SELECT * FROM governance_bootstrap', 'DELETE FROM governance_bootstrap', 'TRUNCATE governance_bootstrap', 'DELETE FROM governance_bootstrap_events']) {
        await assert.rejects(runtime.query(sql), (e: any) => e.code === '42501');
      }
      assert.equal((await owner.query('SELECT count(*) FROM governance_bootstrap_events WHERE actor_account_id=recipient_account_id')).rows[0].count, '0');
    });
    await check('installer and runtime events share one valid audit chain without reason/name/token payloads', async () => {
      let previous = '0'.repeat(64);
      for (const event of (await owner.query('SELECT * FROM audit_log ORDER BY id')).rows) {
        assert.equal(event.previous_hash, previous);
        assert.equal(event.row_hash, hash(`${event.event_type}|${event.payload}|${previous}|${event.created_at}`));
        assert.ok(!event.payload.includes(plan.reason) && !event.payload.includes(plan.organizationName));
        for (const token of tokens) assert.ok(!event.payload.includes(token) && !event.payload.includes(hash(token)));
        previous = event.row_hash;
      }
    });
    await check('ordinary expired-session cleanup preserves the ceremony history and permanent latch', async () => {
      await owner.query("UPDATE admin_sessions SET idle_expires_at=now()-interval '1 second', absolute_expires_at=now()-interval '1 second', step_up_expires_at=NULL");
      await owner.query('DELETE FROM admin_sessions WHERE absolute_expires_at <= now()');
      assert.equal((await owner.query('SELECT count(*) FROM governance_bootstrap_events')).rows[0].count, '3');
      await denied(() => service.arm({ ...plan, id: randomUUID() }));
    });
  });
  await fixture(async ({ service, owner, plan, tokens }) => {
    await check('independent rejection is terminal, idempotent and grants no authority', async () => {
      await service.arm(plan); await service.propose(plan.id, tokens[0]);
      const rejected = await service.decide(plan.id, tokens[1], 'reject');
      assert.equal(rejected.status, 'rejected');
      assert.deepEqual(await service.decide(plan.id, tokens[1], 'reject'), rejected);
      await assert.rejects(service.decide(plan.id, tokens[1], 'confirm'), implementation!.BootstrapDenied);
      await assert.rejects(service.arm({ ...plan, id: randomUUID() }), implementation!.BootstrapDenied);
      await noDomain(owner);
    });
  });
  await fixture(async ({ service, owner, plan, tokens }) => {
    await check('an expired armed plan cannot be endorsed or silently reset', async () => {
      // Synthetic past timestamps, within the same schema constraints; no clock mock.
      await owner.query(`INSERT INTO governance_bootstrap(id, proposer_account_id, confirmer_account_id, organization_name, reason, armed_at, expires_at)
        VALUES($1,$2,$3,$4,$5,now()-interval '11 minutes',now()-interval '1 minute')`,
      [plan.id, plan.proposerAccountId, plan.confirmerAccountId, plan.organizationName, plan.reason]);
      await assert.rejects(service.propose(plan.id, tokens[0]), implementation!.BootstrapDenied);
      await assert.rejects(service.arm(plan), implementation!.BootstrapDenied);
      await noDomain(owner);
    });
  });
  console.log(`PASS ${checks} governance bootstrap scenarios; all disposable databases removed`);
} finally { await control.end(); }
