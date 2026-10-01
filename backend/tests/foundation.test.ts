import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import request from 'supertest';
import pino from 'pino';
import { createApp, type DependencyChecks } from '../src/app.js';
import { readConfig } from '../src/config.js';

const checks: DependencyChecks = { postgres: async () => {}, redis: async () => {}, storage: async () => {} };
const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/ertad', REDIS_URL: 'redis://localhost', STORAGE_HEALTH_URL: 'http://localhost/health', WEB_ORIGIN: 'http://localhost:15173' };
test('production, unknown modes, bypass and missing config fail closed', () => {
  for (const mode of ['production', 'staging', 'Production']) assert.throws(() => readConfig({ ...env, NODE_ENV: mode }));
  assert.throws(() => readConfig({ ...env, DEV_AUTH_BYPASS: 'true' }));
  assert.throws(() => readConfig({ ...env, DATABASE_URL: '' }));
  assert.throws(() => readConfig({ ...env, PORT: '0' }));
  assert.throws(() => readConfig({ ...env, WEB_ORIGIN: '*' }));
  assert.equal(readConfig(env).port, 3000);
});
test('readiness fails for each dependency without exposing errors; liveness remains available', async () => {
  for (const name of Object.keys(checks)) {
    const app = createApp({ ...checks, [name]: async () => { throw new Error('secret-password'); } }, pino({ enabled: false }), env.WEB_ORIGIN);
    const ready = await request(app).get('/health/ready').expect(503);
    assert.deepEqual(ready.body, { status: 'unavailable' });
    await request(app).get('/health/live').expect(200);
  }
});
test('healthy stack, protected routes, bounded IDs and minimal logs', async () => {
  let logs = '';
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
  const app = createApp(checks, pino({}, stream), env.WEB_ORIGIN);
  await request(app).get('/health/ready').expect(200);
  const result = await request(app).post('/api/v1/admin?token=private-query')
    .set('Authorization', 'Bearer private-token').set('X-Request-ID', 'private-id').send({ password: 'private-password' }).expect(401);
  assert.match(result.headers['x-request-id'], /^[a-f0-9-]{36}$/);
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-powered-by'], undefined);
  assert.ok(!logs.includes('private-'));
  await request(app).get('/missing').expect(404);
});
