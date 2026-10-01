import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
try { loadEnvFile('.env'); } catch { /* CI may supply variables directly. */ }
const api = `http://127.0.0.1:${process.env.ERTAD_API_PORT ?? 13000}`;
const web = `http://127.0.0.1:${process.env.ERTAD_WEB_PORT ?? 15173}`;
for (const url of [`${api}/health/live`, `${api}/health/ready`, `${web}/health/ready`]) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, url);
  console.log(`PASS ${url}`);
}
const protectedRoute = await fetch(`${web}/api/v1/me`);
assert.equal(protectedRoute.status, 401);
assert.equal((await protectedRoute.json()).error.code, 'AUTHENTICATION_REQUIRED');
const page = await fetch(web);
assert.equal(page.status, 200);
assert.match(await page.text(), /ERTAD/);
console.log('PASS web, same-origin API proxy, unauthenticated denial');
