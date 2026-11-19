import express from 'express';
import request from 'supertest';
import { addressKey, canonicalIP, equalSecret } from '../src/modules/security/networkIdentity';
import {
  createNetworkControl,
  countryDenied,
  type NetworkSettings,
} from '../src/modules/security/networkControl';
const secret = 's'.repeat(40),
  keySecret = 'k'.repeat(40);
const off: NetworkSettings = { mode: 'off', countries: [], blocked: [], exceptions: [] };
const active = { key: addressKey('192.0.2.1', keySecret), until: '2099-01-01T00:00:00.000Z' };
function app(settings = off, ready = true, fail = false) {
  const api = express();
  api.use(
    createNetworkControl(
      secret,
      keySecret,
      async () => {
        if (fail) throw Error('DB');
        return { version: 1, settings };
      },
      ready
    ).guard
  );
  api.get('/test', (_, res) => res.json({ ok: true }));
  return api;
}
const edge = (api: ReturnType<typeof app>, country = 'GE', ip = '192.0.2.1') =>
  request(api)
    .get('/test')
    .set('Host', 'edge.example')
    .set('x-ertad-proxy-token', secret)
    .set('x-ertad-source', 'cloudflare')
    .set('x-ertad-client-ip', ip)
    .set('x-ertad-country', country);
test('IP aliases share a private keyed identity; malformed addresses cannot become keys', () => {
  expect(canonicalIP('::ffff:192.0.2.1')).toBe('192.0.2.1');
  expect(addressKey('2001:0db8:0:0:0:0:0:1', keySecret)).toBe(addressKey('2001:db8::1', keySecret));
  expect(addressKey('192.0.2.1', keySecret)).not.toBe(addressKey('192.0.2.1', secret));
  for (const ip of ['192.0.2.1, 127.0.0.1', 'example.test', '192.0.2.1/24', '1.2.3', ''])
    expect(() => canonicalIP(ip)).toThrow();
  expect(equalSecret('?'.repeat(40), secret)).toBe(false);
});
test('block overrides exception; expiry restores country policy and unknown countries fail closed', () => {
  const settings: NetworkSettings = {
    mode: 'allow',
    countries: ['GE'],
    blocked: [active],
    exceptions: [active],
  };
  expect(countryDenied(settings, 'GE', active.key)).toBe(true);
  expect(countryDenied({ ...settings, blocked: [] }, 'XX', active.key)).toBe(false);
  expect(countryDenied({ ...settings, blocked: [] }, 'XX', 'other')).toBe(true);
  expect(
    countryDenied(
      { ...settings, blocked: [], exceptions: [{ ...active, until: '2000-01-01T00:00:00Z' }] },
      'DE',
      active.key
    )
  ).toBe(true);
  expect(countryDenied({ ...off, mode: 'deny', countries: ['DE'] }, 'GE', 'other')).toBe(false);
});
test('local recovery bypasses unavailable policy, but supplied proxy claims never do', async () => {
  await request(app(off, true, true))
    .get('/test')
    .expect(200);
  for (const header of [
    'cf-connecting-ip',
    'cf-ipcountry',
    'x-forwarded-for',
    'x-ertad-source',
    'forwarded',
  ])
    await request(app()).get('/test').set(header, '127.0.0.1').expect(403);
  await request(app()).get('/test').set('Host', 'edge.example').expect(403);
});
test('edge needs authenticated hop, valid metadata, and available policy', async () => {
  await edge(app()).expect(200);
  await edge(app()).set('x-ertad-proxy-token', 'wrong').expect(403);
  await edge(app(), 'GE', '127.0.0.1').expect(403);
  await edge(app(), 'invalid').expect(403);
  await edge(app(off, true, true)).expect(503);
  await edge(app({ ...off, mode: 'allow', countries: ['GE'] }, false)).expect(503);
});
test('approved policy gates each remote request without retaining raw IP', async () => {
  const api = app({ ...off, mode: 'allow', countries: ['GE'] });
  await edge(api, 'GE').expect(200);
  await edge(api, 'DE').expect(403);
  await edge(api, 'XX').expect(403);
  const r = await edge(app({ ...off, blocked: [active] })).expect(403);
  expect(JSON.stringify(r.body)).not.toContain('192.0.2.1');
  expect(r.headers['x-ertad-network-country']).toBe('GE');
  expect(r.headers['x-ertad-client-ip']).toBeUndefined();
});
