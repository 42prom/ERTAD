import request from 'supertest';
import express from 'express';
import {
  createApiLimits,
  createLoginLimits,
  loadSecurityLimits,
  defaultSecurityLimits,
  rateLimitKey,
} from '../src/modules/security/securityLimits';

test('policy failures deny API work; health remains available', async () => {
  const app = express();
  app.get('/health', (_q, s) => s.sendStatus(200));
  app.use(
    loadSecurityLimits(async () => {
      throw Error('private database detail');
    })
  );
  app.get('/api', (_q, s) => s.sendStatus(200));
  await request(app).get('/health').expect(200);
  const response = await request(app).get('/api').expect(503);
  expect(JSON.stringify(response.body)).not.toContain('private');
});
test('malformed approved values fail closed instead of silently falling back', async () => {
  const app = express();
  app.use(loadSecurityLimits(async () => ({ ...defaultSecurityLimits, apiPerMinute: 0 })));
  app.get('/', (_q, s) => s.sendStatus(200));
  await request(app).get('/').expect(503);
});
test('lowering an active budget preserves counts; increasing it does not reset counts', async () => {
  let policy = { ...defaultSecurityLimits };
  const app = express();
  app.use(
    loadSecurityLimits(async () => policy),
    createApiLimits()
  );
  app.get('/', (_q, s) => s.sendStatus(200));
  for (let i = 0; i < 60; i++) await request(app).get('/').expect(200);
  policy = { ...policy, version: 1, apiPerMinute: 60 };
  const denied = await request(app).get('/').expect(429);
  expect(denied.headers['retry-after']).toBeDefined();
  policy = { ...policy, version: 2, apiPerMinute: 62 };
  await request(app).get('/').expect(200);
  await request(app).get('/').expect(429);
});
test('successful logins do not consume the failure budget and no forged header changes its key', async () => {
  const app = express();
  app.use(
    loadSecurityLimits(async () => ({ ...defaultSecurityLimits, loginFailures: 3 })),
    createLoginLimits()
  );
  app.get('/', (q, s) => s.sendStatus(q.query.fail ? 401 : 200));
  for (let i = 0; i < 5; i++) await request(app).get('/').expect(200);
  for (let i = 0; i < 3; i++)
    await request(app)
      .get('/?fail=1')
      .set('X-Forwarded-For', '192.0.2.' + (i + 1))
      .expect(401);
  await request(app).get('/').set('X-Forwarded-For', '192.0.2.99').expect(429);
});
test('unverified headers and unrelated locals cannot masquerade as authenticated edge identity', () => {
  const req = {
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-ertad-client-ip': '192.0.2.1' },
  } as any;
  expect(rateLimitKey(req, { locals: { networkRateKey: 'fake' } } as any)).toMatch(/^peer:/);
  expect(
    rateLimitKey(req, {
      locals: { networkSource: 'cloudflare', networkRateKey: 'verified' },
    } as any)
  ).toBe('edge:verified');
});
