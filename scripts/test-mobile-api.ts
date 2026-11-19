import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import pino from 'pino';
import { createClient } from 'redis';

loadEnvFile('.env');
process.env.NODE_ENV = 'test';
process.env.ERTAD_LOCAL_ADMIN = 'true';

const pgPort = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
const redisPort = Number(process.env.ERTAD_REDIS_PORT ?? 16379);
const storagePort = Number(process.env.ERTAD_STORAGE_PORT ?? 19000);
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${pgPort}/ertad`;
process.env.REDIS_URL = `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD!)}@127.0.0.1:${redisPort}/0`;

const { createApp } = await import('../backend/src/app');
const { createLocalAdminRouter } = await import('../backend/src/localAdmin');
const { createLocalMobileRouter } = await import('../backend/src/modules/mobile/router');
const { close } = await import('../backend/src/db/client');

const origin = 'http://localhost:15173';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const app = createApp(
  {
    postgres: async () => {
      await pool.query('SELECT 1');
    },
    redis: async () => {
      await redis.ping();
    },
    storage: async () => {
      const r = await fetch(`http://127.0.0.1:${storagePort}/healthz`);
      if (!r.ok) throw new Error('Storage down');
    },
  },
  pino({ level: 'silent' }),
  origin,
  createLocalAdminRouter(origin),
  undefined,
  undefined,
  undefined,
  createLocalMobileRouter(origin)
);

const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const { port } = server.address() as { port: number };
const base = `http://127.0.0.1:${port}/api/v1/mobile`;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

try {
  // 1. Unauthenticated access rejected
  const unauthRes = await fetch(`${base}/workspace/bootstrap`);
  assert(unauthRes.status === 401, `Expected 401 unauth, got ${unauthRes.status}`);

  // 2. Fetch mobile dev personas (strictly excludes council/platform)
  const personasRes = await fetch(`${base}/dev/personas`);
  assert(personasRes.status === 200, `Expected 200 personas, got ${personasRes.status}`);
  const personasBody = (await personasRes.json()) as {
    enabled: boolean;
    organizationId: string;
    personas: Array<{ id: string; roleKind: string; label: string }>;
  };
  assert(personasBody.enabled, 'Expected mobile personas enabled');
  const memberPersona = personasBody.personas.find((p) => p.roleKind === 'member');
  const managerPersona = personasBody.personas.find((p) => p.roleKind === 'group_manager');
  assert(memberPersona && managerPersona, 'Expected member & group_manager personas');

  // 3. Log in as Member
  const memberLoginRes = await fetch(`${base}/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaId: memberPersona.id }),
  });
  assert(memberLoginRes.status === 200, `Member login failed: ${memberLoginRes.status}`);
  const memberSession = (await memberLoginRes.json()) as {
    sessionToken: string;
    csrfToken: string;
  };
  const memberHeaders = {
    Authorization: `Bearer ${memberSession.sessionToken}`,
    'X-Mobile-CSRF': memberSession.csrfToken,
    'Content-Type': 'application/json',
  };

  // 4. Member workspace bootstrap succeeds with real seeded counts
  const bootRes = await fetch(`${base}/workspace/bootstrap`, { headers: memberHeaders });
  assert(bootRes.status === 200, `Bootstrap failed: ${bootRes.status}`);
  const boot = (await bootRes.json()) as {
    summary: { openDecisions: number; openWork: number; upcomingEvents48h: number };
    channels: Array<{ id: string }>;
  };
  assert(boot.summary.openDecisions >= 3, 'Expected >=3 open seeded decisions');
  assert(boot.summary.openWork >= 1, 'Expected >=1 open seeded work item');
  assert(boot.summary.upcomingEvents48h >= 1, 'Expected >=1 upcoming event');

  // 5. Privacy disclosure supports private_hidden (default), bucketed_k10, and shared_context_opt_in
  const privGet1 = await fetch(
    `${base}/privacy?organizationId=${personasBody.organizationId}`,
    { headers: memberHeaders }
  );
  assert(privGet1.status === 200, `Privacy get failed: ${privGet1.status}`);
  const priv1 = (await privGet1.json()) as { disclosureMode: string; displayName: string | null };
  assert(
    ['private_hidden', 'bucketed_k10', 'shared_context_opt_in'].includes(priv1.disclosureMode),
    'Expected valid disclosure mode'
  );

  const privMissingCsrf = await fetch(`${base}/privacy/update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${memberSession.sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ organizationId: personasBody.organizationId, disclosureMode: 'bucketed_k10' }),
  });
  assert(privMissingCsrf.status === 403, `Expected 403 missing CSRF, got ${privMissingCsrf.status}`);

  const privOptIn = await fetch(`${base}/privacy/update`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({
      organizationId: personasBody.organizationId,
      disclosureMode: 'shared_context_opt_in',
      displayName: 'მარიამი (საბურთალო)',
    }),
  });
  assert(privOptIn.status === 200, `Privacy opt-in update failed: ${privOptIn.status}`);
  const optData = (await privOptIn.json()) as { disclosureMode: string; displayName: string | null };
  assert(optData.disclosureMode === 'shared_context_opt_in' && optData.displayName === 'მარიამი (საბურთალო)', 'Opt-in label not persisted');

  const privReset = await fetch(`${base}/privacy/update`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({
      organizationId: personasBody.organizationId,
      disclosureMode: 'private_hidden',
    }),
  });
  assert(privReset.status === 200, `Privacy reset failed: ${privReset.status}`);
  const resetData = (await privReset.json()) as { disclosureMode: string; displayName: string | null };
  assert(resetData.disclosureMode === 'private_hidden' && resetData.displayName === null, 'Label must clear on private_hidden');

  // 6. Security check: Member hits 428 before step-up AND still 403 after step-up (Postgres enforces scope)
  const payload = {
    key: randomUUID(),
    organizationId: personasBody.organizationId,
    unitId: boot.channels[0]?.id ?? personasBody.organizationId,
    title: 'Unauthorized task',
    description: 'Should be rejected',
    roleLabel: 'Member',
    priority: 'normal',
    capacity: 1,
    deadline: new Date(Date.now() + 86400_000).toISOString(),
  };
  const beforeStepUp = await fetch(`${base}/work/create`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify(payload),
  });
  assert(beforeStepUp.status === 428, `Expected 428 before step-up, got ${beforeStepUp.status}`);
  const stepUpRes = await fetch(`${base}/dev/step-up`, { method: 'POST', headers: memberHeaders });
  assert(stepUpRes.status === 200, `Step-up failed: ${stepUpRes.status}`);
  const memberCreateWork = await fetch(`${base}/work/create`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify(payload),
  });
  assert(memberCreateWork.status === 403, `Expected 403 member create denied, got ${memberCreateWork.status}`);

  // 7. Channels: global, group, direct-peers (privacy-safe), direct-open, post, thread, block & inbox
  const memberChList = await fetch(
    `${base}/channels/list?organizationId=${personasBody.organizationId}&view=active&kind=member_all`,
    { headers: memberHeaders }
  );
  assert(memberChList.status === 200, `Member channels list failed: ${memberChList.status}`);
  const memberChBody = (await memberChList.json()) as {
    items: Array<{ id: string; kind: string; title: string }>;
  };
  assert(memberChBody.items.some((c) => c.kind === 'global'), 'Expected at least one global channel');
  assert(memberChBody.items.some((c) => c.kind === 'group'), 'Expected at least one group channel');

  const peersRes = await fetch(
    `${base}/channels/direct-peers?organizationId=${personasBody.organizationId}`,
    { headers: memberHeaders }
  );
  assert(peersRes.status === 200, `Direct peers failed: ${peersRes.status}`);
  const peersBody = (await peersRes.json()) as {
    items: Array<{ memberId: string; label: string; optIn: boolean; roleKind: string }>;
  };
  assert(peersBody.items.length >= 1, 'Expected at least 1 eligible peer in shared unit');
  assert(
    peersBody.items.every((p) => !p.label.includes('@mobile.ertad.local') && (p.optIn || !p.label.includes('კალანდაძე'))),
    'Private member legal name/email must not leak when private_hidden'
  );
  const peerCoord = peersBody.items.find((p) => p.roleKind === 'coordinator') ?? peersBody.items[0];

  const openKey = randomUUID();
  const dmOpen1 = await fetch(`${base}/channels/direct-open`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({
      organizationId: personasBody.organizationId,
      peerId: peerCoord.memberId,
      key: openKey,
    }),
  });
  assert(dmOpen1.status === 200, `Direct open failed: ${dmOpen1.status}`);
  const dm1 = (await dmOpen1.json()) as { id: string; kind: string; canPost: boolean };
  assert(dm1.kind === 'direct' && dm1.canPost, 'Expected writable direct channel');

  // Idempotent retry returns the exact same channel ID
  const dmOpen2 = await fetch(`${base}/channels/direct-open`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({
      organizationId: personasBody.organizationId,
      peerId: peerCoord.memberId,
      key: openKey,
    }),
  });
  assert(dmOpen2.status === 200, `Direct open retry failed: ${dmOpen2.status}`);
  const dm2 = (await dmOpen2.json()) as { id: string };
  assert(dm2.id === dm1.id, 'Expected idempotent direct channel reuse');

  const dmPostRes = await fetch(`${base}/channels/post`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({
      organizationId: personasBody.organizationId,
      id: dm1.id,
      key: randomUUID(),
      body: 'გამარჯობა, ჯგუფის კოორდინატორო!',
    }),
  });
  assert(dmPostRes.status === 200, `Direct post failed: ${dmPostRes.status}`);

  const dmThreadRes = await fetch(
    `${base}/channels/thread?organizationId=${personasBody.organizationId}&id=${dm1.id}`,
    { headers: memberHeaders }
  );
  assert(dmThreadRes.status === 200, `Direct thread failed: ${dmThreadRes.status}`);
  const dmThread = (await dmThreadRes.json()) as { items: Array<{ body: string }> };
  assert(dmThread.items.some((m) => m.body.includes('გამარჯობა')), 'Expected posted DM message in thread');

  // Block & unblock direct chat
  const dmBlockRes = await fetch(`${base}/channels/direct-block`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({
      organizationId: personasBody.organizationId,
      id: dm1.id,
      key: randomUUID(),
      blocked: true,
    }),
  });
  assert(dmBlockRes.status === 200, `Direct block failed: ${dmBlockRes.status}`);
  const blockedPostRes = await fetch(`${base}/channels/post`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({
      organizationId: personasBody.organizationId,
      id: dm1.id,
      key: randomUUID(),
      body: 'Blocked attempt',
    }),
  });
  assert(blockedPostRes.status === 403, `Expected 403 when blocked, got ${blockedPostRes.status}`);
  const dmUnblockRes = await fetch(`${base}/channels/direct-block`, {
    method: 'POST',
    headers: memberHeaders,
    body: JSON.stringify({
      organizationId: personasBody.organizationId,
      id: dm1.id,
      key: randomUUID(),
      blocked: false,
    }),
  });
  assert(dmUnblockRes.status === 200, `Direct unblock failed: ${dmUnblockRes.status}`);

  const inboxListRes = await fetch(
    `${base}/inbox?organizationId=${personasBody.organizationId}&view=all`,
    { headers: memberHeaders }
  );
  assert(inboxListRes.status === 200, `Inbox list failed: ${inboxListRes.status}`);

  // 8. Group Manager session reads decisions, notifications prefs (0068), and logs out cleanly
  const mgrLoginRes = await fetch(`${base}/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaId: managerPersona.id }),
  });
  assert(mgrLoginRes.status === 200, `Manager login failed: ${mgrLoginRes.status}`);
  const mgrSession = (await mgrLoginRes.json()) as { sessionToken: string; csrfToken: string };
  const mgrHeaders = {
    Authorization: `Bearer ${mgrSession.sessionToken}`,
    'X-Mobile-CSRF': mgrSession.csrfToken,
    'Content-Type': 'application/json',
  };

  const decisionsList = await fetch(
    `${base}/decisions/list?organizationId=${personasBody.organizationId}&view=open`,
    { headers: mgrHeaders }
  );
  assert(decisionsList.status === 200, `Decisions list failed: ${decisionsList.status}`);

  const prefsRes = await fetch(`${base}/account/notifications`, { headers: mgrHeaders });
  assert(prefsRes.status === 200, `Notifications prefs failed: ${prefsRes.status}`);

  const logoutRes = await fetch(`${base}/dev/logout`, { method: 'POST', headers: mgrHeaders });
  assert(logoutRes.status === 200, `Logout failed: ${logoutRes.status}`);

  const afterLogout = await fetch(`${base}/workspace/bootstrap`, { headers: mgrHeaders });
  assert(afterLogout.status === 401, `Expected 401 after logout, got ${afterLogout.status}`);

  await fetch(`${base}/dev/logout`, { method: 'POST', headers: memberHeaders });
  console.log('PASS test:mobile-api (all auth, CSRF, bootstrap, privacy, scope denial & prefs checks)');
} finally {
  server.close();
  await pool.end();
  await redis.quit();
  await close();
}
