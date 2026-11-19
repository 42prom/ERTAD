import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import bcrypt from 'bcrypt';
import request from 'supertest';
import pino from 'pino';
import { Router } from 'express';

// Synthetic account in a disposable database on ERTAD's own local PostgreSQL.
// This runner never reads or resets the developer's administrator credentials.
loadEnvFile('.env');
const database = `ertad_auth_test_${randomBytes(8).toString('hex')}`;
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(process.env.POSTGRES_PASSWORD && process.env.APP_DB_PASSWORD);
const connection = { host: '127.0.0.1', port, user: 'ertad_owner', password: process.env.POSTGRES_PASSWORD, connectionTimeoutMillis: 3000 };
const control = new pg.Client({ ...connection, database: 'ertad' });
const owner = new pg.Client({ ...connection, database, options: '-c search_path=ertad,public' });
let created = false;
let connected = false;
let closeRuntime: (() => Promise<void>) | undefined;
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;
process.env.API_KEY_ENCRYPTION_SECRET = randomBytes(32).toString('base64url');
const origin = 'http://localhost:15173';
const email = 'synthetic@example.invalid';
const password = randomBytes(24).toString('base64url');
// Public RFC 6238 test vector, never an actual account secret.
const mfaSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
function otp(counter = Math.floor(Date.now() / 30000)) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from('12345678901234567890')).update(bytes).digest();
  return ((digest.readUInt32BE(digest[digest.length - 1]! & 15) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

await control.connect();
try {
  await control.query(`CREATE DATABASE ${database}`);
  created = true;
  await owner.connect();
  connected = true;
  await owner.query('CREATE SCHEMA ertad; CREATE TABLE ertad.schema_migrations (version text PRIMARY KEY, checksum text NOT NULL)');
  const migrations = new URL('../backend/db/foundation/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    await owner.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  const { pool, close } = await import('../backend/src/db/client.ts');
  closeRuntime = close;
  const { encryptSensitiveValue } = await import('../backend/src/services/secretEncryption.ts');
  const { matchMfaCounter } = await import('../backend/src/services/adminMfa.ts');
  const { createLocalAdminRouter } = await import('../backend/src/localAdmin.ts');
  const { createAdminAuthRouter } = await import('../backend/src/routes/admin/auth.ts');
  const { createApp } = await import('../backend/src/app.ts');
  const { SecurityService } = await import('../backend/src/services/security.ts');
  const { createAdminSession } = await import('../backend/src/services/adminSession.ts');
  const checks = { postgres: async () => {}, redis: async () => {}, storage: async () => {} };
  const freshApp = () => createApp(checks, pino({ enabled: false }), origin, createLocalAdminRouter(origin));
  let app = freshApp();
  const strictApp = createApp(checks, pino({ enabled: false }), origin, Router().use('/auth', createAdminAuthRouter()));
  process.env.NODE_ENV = 'production';
  assert.throws(() => createLocalAdminRouter(origin));
  assert.throws(() => createAdminAuthRouter({ requireMfa: false }));
  process.env.NODE_ENV = 'test';
  const api = '/api/v1/admin';
  const inserted = await owner.query(
    `INSERT INTO admin_users (email, password_hash, role, mfa_secret_encrypted) VALUES ($1, $2, 'superadmin', $3) RETURNING id`,
    [email, await bcrypt.hash(password, 10), encryptSensitiveValue(mfaSecret)],
  );
  const id = inserted.rows[0].id;
  const login = (body: Record<string, unknown> = { email, password }) => request(app).post(`${api}/auth/login`).set('Origin', origin).send(body);
  const resetFixture = async () => {
    // Only this disposable synthetic account and this runner's in-memory limiters.
    await owner.query('UPDATE admin_users SET failed_login_attempts = 0, locked_until = NULL, mfa_last_counter = -1, is_active = true WHERE id = $1', [id]);
    // Fresh per-application stores between scenarios; no production reset API.
    app = freshApp();
  };
  const cookieOf = (response: request.Response) => {
    const cookies = response.headers['set-cookie'] as unknown as string[];
    assert.ok(cookies?.[0]?.includes('HttpOnly') && cookies[0].includes('SameSite=Strict'));
    return cookies[0]!.split(';')[0]!;
  };
  const deniedSql = (sql: string) => assert.rejects(pool.query(sql), (error: any) => error.code === '42501');

  const mfaState = async (accountId: string) => (await owner.query(
    'SELECT mfa_enabled,mfa_enrolled_at,mfa_last_counter FROM admin_users WHERE id=$1', [accountId]
  )).rows[0];
  assert.deepEqual(await mfaState(id), { mfa_enabled: false, mfa_enrolled_at: null, mfa_last_counter: '-1' });
  for (const clause of ['mfa_enabled=true', 'mfa_enrolled_at=now()', 'mfa_last_counter=0'])
    await assert.rejects(owner.query(`UPDATE admin_users SET ${clause} WHERE id=$1`, [id]),
      (error: any) => error.code === '23514');

  const pendingEmail = 'pending@example.invalid';
  const pendingId = (await owner.query(
    `INSERT INTO admin_users(email,password_hash,role) VALUES($1,$2,'observer') RETURNING id`,
    [pendingEmail, await bcrypt.hash(password, 10)]
  )).rows[0].id;
  const pendingLocal = await request(freshApp()).post(`${api}/auth/login`).set('Origin', origin)
    .send({ email: pendingEmail, password, totpCode: otp() }).expect(200);
  assert.deepEqual(await mfaState(pendingId), { mfa_enabled: false, mfa_enrolled_at: null, mfa_last_counter: '-1' });
  const noEnrollment = await request(strictApp).post(`${api}/auth/login`).set('Origin', origin)
    .send({ email: pendingEmail, password, totpCode: otp() }).expect(403);
  assert.equal(noEnrollment.body.error.code, 'MFA_ENROLLMENT_REQUIRED');
  assert.equal(noEnrollment.headers['set-cookie'], undefined);
  await request(strictApp).post(`${api}/auth/login`).set('Origin', origin)
    .send({ email: pendingEmail, password: 'wrong' }).expect(401);
  await request(freshApp()).post(`${api}/auth/step-up`).set('Origin', origin)
    .set('Cookie', cookieOf(pendingLocal)).set('X-Admin-Csrf', pendingLocal.body.csrfToken)
    .send({ password }).expect(200);
  // Strict step-up never completes enrollment, even with a provisioned secret and valid OTP.
  await owner.query('UPDATE admin_users SET mfa_secret_encrypted=$2 WHERE id=$1', [pendingId, encryptSensitiveValue(mfaSecret)]);
  await request(strictApp).post(`${api}/auth/step-up`).set('Origin', origin)
    .set('Cookie', cookieOf(pendingLocal)).set('X-Admin-Csrf', pendingLocal.body.csrfToken)
    .send({ password, totpCode: otp() }).expect(401);
  assert.deepEqual(await mfaState(pendingId), { mfa_enabled: false, mfa_enrolled_at: null, mfa_last_counter: '-1' });
  // Remove only this extra disposable fixture before legacy tests assert session totals.
  await owner.query('DELETE FROM admin_users WHERE id=$1', [pendingId]);
  console.log('PASS pending MFA defaults and SQL invariants; local password-only access; strict missing-enrollment and pending step-up denial');

  const originalAudit = SecurityService.logAuditEventInTransaction;
  for (const mode of ['outage', 'tamper'] as const) {
    const isolatedStrict = createApp(checks, pino({ enabled: false }), origin, Router().use('/auth', createAdminAuthRouter()));
    SecurityService.logAuditEventInTransaction = async (client, event, payload) => {
      await originalAudit(client, event, payload);
      if (event !== 'ADMIN_MFA_ENROLLED') return;
      if (mode === 'outage') throw new Error('synthetic enrollment audit outage');
      await client.query('UPDATE admin_users SET mfa_enabled=false,mfa_enrolled_at=NULL,mfa_last_counter=-1 WHERE id=$1', [id]);
    };
    try {
      const result = await request(isolatedStrict).post(`${api}/auth/login`).set('Origin', origin)
        .send({ email, password, totpCode: otp() }).expect(mode === 'outage' ? 500 : 401);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.deepEqual(await mfaState(id), { mfa_enabled: false, mfa_enrolled_at: null, mfa_last_counter: '-1' });
      assert.equal(Number((await owner.query("SELECT count(*) FROM audit_log WHERE event_type='ADMIN_MFA_ENROLLED'")).rows[0].count), 0);
    } finally { SecurityService.logAuditEventInTransaction = originalAudit; }
  }
  console.log('PASS enrollment and its audit roll back together on audit failure and final-state tampering');

  assert.equal(otp(1), '287082');
  assert.equal(matchMfaCounter(mfaSecret, '287082', 59000), 1);
  assert.equal(matchMfaCounter(mfaSecret, '287082', 150000), null);
  await request(app).get(`${api}/auth/me`).expect(401);
  await request(app).get(`${api}/auth/me`).set('Authorization', 'Bearer untrusted-mobile-token').set('X-Admin-Role', 'superadmin').expect(401);
  await request(app).post(`${api}/auth/login`).send({ email, password, totpCode: otp() }).expect(403);
  await request(app).post(`${api}/auth/login`).set('Origin', 'https://untrusted.example.invalid').send({ email, password, totpCode: otp() }).expect(403);
  await request(strictApp).post(`${api}/auth/login`).set('Origin', origin).send({ email, password }).expect(401);
  await login({ email, password: 'incorrect', totpCode: otp() }).expect(401);
  const first = await login().expect(200);
  assert.deepEqual(await mfaState(id), { mfa_enabled: false, mfa_enrolled_at: null, mfa_last_counter: '-1' });
  assert.equal(Number((await owner.query('SELECT mfa_last_counter FROM admin_users WHERE id = $1', [id])).rows[0].mfa_last_counter), -1);
  const cookie = cookieOf(first);
  const csrf = first.body.csrfToken as string;
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
  const session = (await owner.query('SELECT * FROM admin_sessions')).rows[0];
  assert.notEqual(session.token_hash, cookie.split('=')[1]);
  assert.notEqual(session.csrf_token_encrypted, csrf);
  assert.equal(session.ip_address, null);
  assert.equal(session.user_agent, null);
  const parallelMe = await Promise.all([1, 2, 3].map(() => request(app).get(`${api}/auth/me`).set('Cookie', cookie).expect(200)));
  assert.ok(parallelMe.every(result => result.body.csrfToken === csrf));
  const strictLogin = await request(strictApp).post(`${api}/auth/login`).set('Origin', origin).send({ email, password, totpCode: otp() }).expect(200);
  const enrolled = await mfaState(id);
  assert.equal(enrolled.mfa_enabled, true);
  assert.ok(enrolled.mfa_enrolled_at instanceof Date);
  assert.ok(Number(enrolled.mfa_last_counter) >= 0);
  assert.equal(Number((await owner.query("SELECT count(*) FROM audit_log WHERE event_type='ADMIN_MFA_ENROLLED'")).rows[0].count), 1);
  await request(strictApp).post(`${api}/auth/login`).set('Origin', origin).send({ email, password, totpCode: otp() }).expect(401);
  await request(strictApp).post(`${api}/auth/step-up`).set('Origin', origin).set('Cookie', cookieOf(strictLogin)).set('X-Admin-Csrf', strictLogin.body.csrfToken).send({ password }).expect(401);
  await request(app).get(`${api}/profiles`).set('Cookie', cookie).expect(403);
  for (const path of ['/api/v1/polls/synthetic/vote', '/api/v1/polls/synthetic/survey-submit', '/api/v1/public/verify-receipt']) {
    // The local web session is deliberately scoped to the admin namespace.
    const denied = await request(app).post(path).set('Origin', origin).set('Cookie', cookie)
      .set('X-Admin-Csrf', csrf).send({}).expect(401);
    assert.equal(denied.body.error.code, 'AUTHENTICATION_REQUIRED');
  }
  await request(app).post(`${api}/users`).set('Origin', origin).set('Cookie', cookie).set('X-Admin-Csrf', csrf).send({ role: 'superadmin' }).expect(403);
  for (const path of ['logout', 'step-up']) {
    await request(app).post(`${api}/auth/${path}`).set('Origin', origin).set('Cookie', cookie).send({ password, totpCode: otp() }).expect(403);
    await request(app).post(`${api}/auth/${path}`).set('Origin', origin).set('Cookie', cookie).set('X-Admin-Csrf', randomBytes(32).toString('base64url')).send({ password, totpCode: otp() }).expect(403);
  }
  await request(app).post(`${api}/auth/step-up`).set('Origin', origin).set('Cookie', cookie).set('X-Admin-Csrf', csrf).send({ password }).expect(200);
  await request(app).post(`${api}/auth/logout`).set('Origin', origin).set('Cookie', cookie).set('X-Admin-Csrf', csrf).expect(204);
  await request(app).get(`${api}/auth/me`).set('Cookie', cookie).expect(401);
  console.log('PASS local password-only login/step-up; strict MFA missing-code/replay denial; production guard; mobile-token denial, stable CSRF, logout and domain denial');

  // Session creation must still match the exact MFA proof validated by strict login.
  const account = (await owner.query('SELECT password_hash,mfa_secret_encrypted,mfa_last_counter FROM admin_users WHERE id=$1', [id])).rows[0];
  let issued = false;
  await assert.rejects(createAdminSession(id, {} as any, { append() { issued = true; } } as any,
    account.password_hash, email, { encryptedSecret: account.mfa_secret_encrypted, counter: Number(account.mfa_last_counter) - 1 }),
    (error: any) => error.statusCode === 401);
  assert.equal(issued, false);
  SecurityService.logAuditEventInTransaction = async (client, event, payload) => {
    await originalAudit(client, event, payload);
    if (event === 'ADMIN_LOGIN_SUCCEEDED')
      await client.query('UPDATE admin_users SET mfa_enabled=false,mfa_enrolled_at=NULL,mfa_last_counter=-1 WHERE id=$1', [id]);
  };
  try {
    await assert.rejects(createAdminSession(id, {} as any, { append() { issued = true; } } as any,
      account.password_hash, email, { encryptedSecret: account.mfa_secret_encrypted, counter: Number(account.mfa_last_counter) }),
      (error: any) => error.statusCode === 401);
    assert.equal(issued, false);
    assert.deepEqual(await mfaState(id), enrolled);
  } finally { SecurityService.logAuditEventInTransaction = originalAudit; }
  console.log('PASS strict-login MFA proof binding before session creation and after session audit');

  await resetFixture();
  const expiryLogin = await login().expect(200);
  const expiryCookie = cookieOf(expiryLogin);
  await owner.query('UPDATE admin_users SET is_active = false WHERE id = $1', [id]);
  await request(app).get(`${api}/auth/me`).set('Cookie', expiryCookie).expect(401);
  await owner.query('UPDATE admin_users SET is_active = true, locked_until = NOW() + INTERVAL \'1 minute\' WHERE id = $1', [id]);
  await request(app).get(`${api}/auth/me`).set('Cookie', expiryCookie).expect(401);
  await owner.query('UPDATE admin_users SET locked_until = NULL WHERE id = $1', [id]);
  await owner.query("UPDATE admin_sessions SET idle_expires_at = NOW() - INTERVAL '1 second' WHERE revoked_at IS NULL");
  await request(app).get(`${api}/auth/me`).set('Cookie', expiryCookie).expect(401);
  await owner.query("UPDATE admin_sessions SET idle_expires_at = NOW() - INTERVAL '2 seconds', absolute_expires_at = NOW() - INTERVAL '1 second' WHERE revoked_at IS NULL");
  await request(app).get(`${api}/auth/me`).set('Cookie', expiryCookie).expect(401);
  console.log('PASS disabled/locked accounts and idle/absolute session expiry');

  await deniedSql("UPDATE admin_users SET role = 'observer'");
  await deniedSql("UPDATE admin_users SET password_hash = 'forged'");
  await deniedSql('INSERT INTO admin_users DEFAULT VALUES');
  for (const sql of ["UPDATE audit_log SET payload = '{}'", 'DELETE FROM audit_log', 'TRUNCATE audit_log']) await deniedSql(sql);
  await assert.rejects(owner.query('DELETE FROM audit_log'), /append-only/);
  await resetFixture();
  const before = (await owner.query('SELECT count(*) FROM admin_sessions')).rows[0].count;
  await owner.query('REVOKE INSERT ON audit_log FROM ertad_app');
  const unaudited = await login().expect(500);
  assert.equal(unaudited.headers['set-cookie'], undefined);
  assert.equal((await owner.query('SELECT count(*) FROM admin_sessions')).rows[0].count, before);
  await owner.query('GRANT INSERT ON audit_log TO ertad_app');
  console.log('PASS runtime cannot create/elevate accounts or mutate audit; audit failure rolls back session');

  await resetFixture();
  const lastCookies: string[] = [];
  for (let i = 0; i < 4; i++) {
    await resetFixture();
    lastCookies.push(cookieOf(await login().expect(200)));
  }
  assert.equal(Number((await owner.query('SELECT count(*) FROM admin_sessions WHERE revoked_at IS NULL')).rows[0].count), 3);
  await request(app).get(`${api}/auth/me`).set('Cookie', lastCookies[0]!).expect(401);
  await request(app).get(`${api}/auth/me`).set('Cookie', lastCookies[3]!).expect(200);
  await resetFixture();
  for (let i = 0; i < 5; i++) await login({ email, password: 'incorrect', totpCode: otp() }).expect(401);
  const locked = (await owner.query('SELECT failed_login_attempts, locked_until > NOW() AS locked FROM admin_users WHERE id = $1', [id])).rows[0];
  assert.equal(locked.failed_login_attempts, 5);
  assert.equal(locked.locked, true);
  await login().expect(429);
  console.log('PASS concurrent-session bound, account lockout and login rate limit');

  const events = (await owner.query('SELECT * FROM audit_log ORDER BY id')).rows;
  let previous = '0'.repeat(64);
  for (const event of events) {
    assert.equal(event.previous_hash, previous);
    assert.equal(event.row_hash, createHash('sha256').update(`${event.event_type}|${event.payload}|${previous}|${event.created_at}`).digest('hex'));
    const payload = JSON.parse(event.payload);
    assert.ok(Object.keys(payload).every(key => ['reason', 'adminUserId', 'session'].includes(key)));
    assert.ok(!event.payload.includes(email) && !event.payload.includes(password) && !event.payload.includes(mfaSecret));
    previous = event.row_hash;
  }
  console.log('PASS audit hash chain and minimal event payloads');
} finally {
  if (closeRuntime) await closeRuntime();
  if (connected) await owner.end();
  if (!/^ertad_auth_test_[a-f0-9]{16}$/.test(database)) throw new Error('Invalid scratch database target');
  if (created) await control.query(`DROP DATABASE ${database}`);
  await control.end();
}
