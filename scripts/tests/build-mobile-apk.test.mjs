import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMobileBuildArgs } from '../build-mobile-apk.mjs';

test('resolveMobileBuildArgs --tunnel reads ERTAD_TUNNEL_ORIGIN and normalizes /api/v1', () => {
  const result = resolveMobileBuildArgs(['--tunnel'], {
    ERTAD_TUNNEL_ORIGIN: 'https://tunnel.example.invalid/',
  });
  assert.equal(result.mode, 'tunnel');
  assert.equal(result.apiBaseUrl, 'https://tunnel.example.invalid/api/v1');
  assert.deepEqual(result.args, [
    'build',
    'apk',
    '--debug',
    '--dart-define=ERTAD_DEV_WORKSPACE=true',
    '--dart-define=API_BASE_URL=https://tunnel.example.invalid/api/v1',
  ]);
});

test('resolveMobileBuildArgs --tunnel fails cleanly when ERTAD_TUNNEL_ORIGIN is missing or HTTP', () => {
  assert.throws(() => resolveMobileBuildArgs(['--tunnel'], {}), /Missing ERTAD_TUNNEL_ORIGIN/);
  assert.throws(
    () =>
      resolveMobileBuildArgs(['--tunnel'], {
        ERTAD_TUNNEL_ORIGIN: 'http://tunnel.example.invalid',
      }),
    /HTTPS is required/
  );
});

test('resolveMobileBuildArgs --local uses configured ERTAD_API_PORT or default 13000', () => {
  const dflt = resolveMobileBuildArgs(['--local'], {});
  assert.equal(dflt.mode, 'local');
  assert.equal(dflt.apiBaseUrl, 'http://127.0.0.1:13000/api/v1');
  assert.deepEqual(dflt.args, [
    'build',
    'apk',
    '--debug',
    '--dart-define=ERTAD_DEV_WORKSPACE=true',
    '--dart-define=API_BASE_URL=http://127.0.0.1:13000/api/v1',
  ]);

  const custom = resolveMobileBuildArgs(['--local'], { ERTAD_API_PORT: '14000' });
  assert.equal(custom.apiBaseUrl, 'http://127.0.0.1:14000/api/v1');
});

test('resolveMobileBuildArgs --release normalizes trailing slashes, omits dev flags, and rejects insecure hosts', () => {
  const withPath = resolveMobileBuildArgs([
    '--release',
    '--api-url=https://api.example.invalid/api/v1///',
  ]);
  assert.equal(withPath.mode, 'release');
  assert.equal(withPath.apiBaseUrl, 'https://api.example.invalid/api/v1');
  assert.equal(
    withPath.args.some((a) => a.includes('ERTAD_DEV_WORKSPACE')),
    false
  );
  assert.deepEqual(withPath.args, [
    'build',
    'appbundle',
    '--release',
    '--dart-define=FLAVOR=prod',
    '--dart-define=API_BASE_URL=https://api.example.invalid/api/v1',
  ]);

  const rootOnly = resolveMobileBuildArgs([
    '--release',
    '--api-url',
    'https://api.example.invalid/',
  ]);
  assert.equal(rootOnly.apiBaseUrl, 'https://api.example.invalid/api/v1');

  assert.throws(
    () => resolveMobileBuildArgs(['--release', '--api-url=http://api.example.invalid/api/v1']),
    /HTTPS is required/
  );
  assert.throws(
    () => resolveMobileBuildArgs(['--release', '--api-url=https://127.0.0.1/api/v1']),
    /Loopback\/emulator host is not allowed/
  );
  assert.throws(
    () => resolveMobileBuildArgs(['--release', '--api-url=https://localhost/api/v1']),
    /Loopback\/emulator host is not allowed/
  );
});
