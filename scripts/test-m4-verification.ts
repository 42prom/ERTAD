import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import bcrypt from 'bcrypt';
import pg from 'pg';
import pino from 'pino';

loadEnvFile('.env');
process.env.NODE_ENV = 'test';
process.env.ERTAD_LOCAL_ADMIN = 'true';

const pgPort = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
const redisPort = Number(process.env.ERTAD_REDIS_PORT ?? 16379);
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${pgPort}/ertad`;
process.env.REDIS_URL = `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD!)}@127.0.0.1:${redisPort}/0`;

const { createApp } = await import('../backend/src/app');
const { createLocalAdminRouter } = await import('../backend/src/localAdmin');
const { createLocalMobileRouter } = await import('../backend/src/modules/mobile/router');
const { close } = await import('../backend/src/db/client');

const ownerPool = new pg.Pool({
  connectionString: `postgresql://${encodeURIComponent(process.env.POSTGRES_USER || 'ertad')}:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:${pgPort}/ertad`,
  max: 2,
});

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function run(): Promise<void> {
  process.env.NODE_ENV = 'development';
  const origin = 'http://127.0.0.1:15173';
  const app = createApp(
    {
      postgres: async () => {
        await ownerPool.query('SELECT 1');
      },
      redis: async () => 'PONG',
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
  const base = `http://127.0.0.1:${port}/api/v1`;

  const readerId = randomUUID();
  const proposerId = randomUUID();
  const approverId = randomUUID();
  const createdAdmins = [readerId, proposerId, approverId];

  try {
    // Seed 3 isolated technical operators with distinct Read / Propose / Approve+Control capabilities
    const pwHash = await bcrypt.hash('M4TestPassword!2026', 10);
    const ops = [
      { id: readerId, email: `m4-reader-${readerId.slice(0, 8)}@ertad.local`, perms: ['platform.read', 'platform.verification.read', 'platform.integrations.read'] },
      { id: proposerId, email: `m4-proposer-${proposerId.slice(0, 8)}@ertad.local`, perms: ['platform.read', 'platform.verification.read', 'platform.verification.propose'] },
      { id: approverId, email: `m4-approver-${approverId.slice(0, 8)}@ertad.local`, perms: ['platform.read', 'platform.verification.read', 'platform.verification.approve', 'platform.mobile_devices.control'] },
    ];

    for (const op of ops) {
      await ownerPool.query(
        `INSERT INTO ertad.admin_users (id, email, full_name, password_hash, role, is_active, mfa_enabled)
         VALUES ($1, $2, $3, $4, 'admin', true, false)`,
        [op.id, op.email, 'M4 Test Operator', pwHash]
      );
      await ownerPool.query(
        `INSERT INTO ertad.platform_accounts (admin_user_id, permissions, valid_until)
         VALUES ($1, $2, now() + interval '1 day')`,
        [op.id, op.perms]
      );
    }

    async function openAdminCookies(_adminId: string, email: string) {
      const loginRes = await fetch(`${base}/admin/auth/login`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'M4TestPassword!2026' }),
      });
      assert(loginRes.status === 200, `Admin login failed for ${email}: ${loginRes.status}`);
      const setCookies = loginRes.headers.getSetCookie();
      const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
      const loginBody = (await loginRes.json()) as { csrfToken: string };
      const headers = {
        Cookie: cookieHeader,
        Origin: origin,
        'X-Admin-CSRF': loginBody.csrfToken,
        'Content-Type': 'application/json',
      };
      const stepRes = await fetch(`${base}/admin/auth/step-up`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: 'M4TestPassword!2026' }),
      });
      assert(stepRes.status === 200, `Admin step-up failed for ${email}: ${stepRes.status}`);
      return headers;
    }

    const readerHeaders = await openAdminCookies(readerId, ops[0].email);
    const proposerHeaders = await openAdminCookies(proposerId, ops[1].email);
    const approverHeaders = await openAdminCookies(approverId, ops[2].email);

    // 1. Read-only operator can read policy & devices, DENIED on propose/control
    const getPol = await fetch(`${base}/admin/platform/verification/policy`, { headers: readerHeaders });
    assert(getPol.status === 200, `Reader GET policy failed: ${getPol.status}`);
    const polBody = (await getPol.json()) as { policy: { version: number; authProfile: string } };
    const startVersion = polBody.policy.version;

    const readerPropose = await fetch(`${base}/admin/platform/verification/policy/propose`, {
      method: 'POST',
      headers: readerHeaders,
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedVersion: startVersion,
        authProfile: 'google_hybrid',
        requireDeviceAttestation: true,
        requireNfc: true,
        requireGeorgianCitizen: true,
        livenessProvider: '3d_face_detector',
        faceMatchProvider: 'custom_biometric_matcher',
        livenessMinScore: 0.85,
        faceMatchMinScore: 0.8,
        retryLimit: 3,
        biometricTtlSeconds: 600,
        reason: 'security_tightening',
      }),
    });
    assert(readerPropose.status === 403, `Expected 403 for read-only propose, got ${readerPropose.status}`);

    // 2. Proposer proposes -> cannot self-approve -> Approver approves (Sovereign ERTAD providers + flexible 0.40 threshold)
    const propRes = await fetch(`${base}/admin/platform/verification/policy/propose`, {
      method: 'POST',
      headers: proposerHeaders,
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedVersion: startVersion,
        authProfile: 'google_hybrid',
        requireDeviceAttestation: true,
        requireNfc: true,
        requireGeorgianCitizen: true,
        livenessProvider: '3d_face_detector',
        faceMatchProvider: 'custom_biometric_matcher',
        livenessMinScore: 0.70,
        faceMatchMinScore: 0.40,
        retryLimit: 3,
        biometricTtlSeconds: 600,
        apiKey: 'secret-biometric-key-example',
        reason: 'security_tightening',
      }),
    });
    assert(propRes.status === 200, `Propose failed: ${propRes.status}`);
    const propJson = (await propRes.json()) as { proposalId: string };

    const selfApprove = await fetch(`${base}/admin/platform/verification/policy/review`, {
      method: 'POST',
      headers: proposerHeaders,
      body: JSON.stringify({ requestId: randomUUID(), proposalId: propJson.proposalId, action: 'approve' }),
    });
    assert(selfApprove.status === 403, `Expected 403 on self-approve, got ${selfApprove.status}`);

    const approveRes = await fetch(`${base}/admin/platform/verification/policy/review`, {
      method: 'POST',
      headers: approverHeaders,
      body: JSON.stringify({ requestId: randomUUID(), proposalId: propJson.proposalId, action: 'approve' }),
    });
    assert(approveRes.status === 200, `Approve failed: ${approveRes.status}`);

    // Verify encrypted credential is never returned
    const afterPol = (await (await fetch(`${base}/admin/platform/verification/policy`, { headers: readerHeaders })).json()) as {
      policy: { version: number; livenessProvider: string; faceMatchMinScore: number; hasCredential: boolean; credentialCipher?: unknown };
    };
    assert(afterPol.policy.version === startVersion + 1, 'Expected version increment');
    assert(afterPol.policy.livenessProvider === '3d_face_detector', 'Expected sovereign livenessProvider');
    assert(Number(afterPol.policy.faceMatchMinScore) === 0.40, 'Expected flexible 0.40 faceMatchMinScore');
    assert(afterPol.policy.hasCredential === true && !('credentialCipher' in afterPol.policy), 'Secret cipher must never leak');

    // 3. Mobile M4 flow: Member login -> isolation check -> challenge/attest -> replay rejected -> Google bind -> eID complete -> duplicate person rejected
    const personasRes = await fetch(`${base}/mobile/dev/personas`);
    const personasBody = (await personasRes.json()) as { personas: Array<{ id: string; memberId: string; roleKind: string }> };
    const member = personasBody.personas.find((p) => p.roleKind === 'member')!;
    const manager = personasBody.personas.find((p) => p.roleKind === 'group_manager')!;
    // Ensure dev member starts unverified so Zero Trust gate & biometric flow are tested cleanly
    await ownerPool.query('DELETE FROM ertad.member_identity_proofs WHERE member_id = $1', [member.memberId]);

    const mLogin = (await (await fetch(`${base}/mobile/dev/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personaId: member.id }),
    })).json()) as { sessionToken: string; csrfToken: string };
    const mHeaders = {
      Authorization: `Bearer ${mLogin.sessionToken}`,
      'X-Mobile-CSRF': mLogin.csrfToken,
      'Content-Type': 'application/json',
    };

    // Mobile token cannot access admin platform verification endpoints or replay as a web session cookie
    const mobAdminTry = await fetch(`${base}/admin/platform/verification/policy`, { headers: mHeaders });
    assert(mobAdminTry.status === 401 || mobAdminTry.status === 403, `Mobile token must be denied on admin platform: ${mobAdminTry.status}`);
    const mobCookieReplay = await fetch(`${base}/admin/auth/me`, {
      headers: { Cookie: `ertad_admin_session=${mLogin.sessionToken}` },
    });
    assert(mobCookieReplay.status === 401, `Mobile bearer token must NOT authenticate as web cookie: ${mobCookieReplay.status}`);

    // Platform diagnostics (/platform/integrations) & GET CSRF block (/platform/reviewMailPolicy)
    const diagRes = await fetch(`${base}/admin/platform/integrations`, { headers: readerHeaders });
    assert(diagRes.status === 200, `Expected 200 on platform/integrations, got ${diagRes.status}`);
    const csrfGetTry = await fetch(`${base}/admin/platform/reviewMailPolicy`, { headers: approverHeaders });
    assert(csrfGetTry.status === 403 || csrfGetTry.status === 404, `GET /platform/reviewMailPolicy must not be mounted: ${csrfGetTry.status}`);

    const m4Status = await fetch(`${base}/mobile/m4/status`, { headers: mHeaders });
    assert(m4Status.status === 200, `M4 status failed: ${m4Status.status}`);

    // Zero Trust Gate: unverified member is blocked from chats (403 BIOMETRIC_VERIFICATION_REQUIRED)
    const orgRowEarly = await ownerPool.query<{ id: string }>('SELECT id FROM ertad.organizations LIMIT 1');
    const orgIdEarly = orgRowEarly.rows[0]?.id;
    if (orgIdEarly) {
      const blockedChats = await fetch(`${base}/mobile/channels/list?organizationId=${orgIdEarly}`, { headers: mHeaders });
      assert(blockedChats.status === 403, `Expected 403 for unverified member on /mobile/channels/list, got ${blockedChats.status}`);
      const blockedBody = (await blockedChats.json()) as { code?: string; error?: { code?: string } };
      assert(
        blockedBody.code === 'BIOMETRIC_VERIFICATION_REQUIRED' &&
          blockedBody.error?.code === 'BIOMETRIC_VERIFICATION_REQUIRED',
        `Expected BIOMETRIC_VERIFICATION_REQUIRED, got ${JSON.stringify(blockedBody)}`
      );
    }

    const chalRes = await fetch(`${base}/mobile/m4/attestation/challenge`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({ platform: 'android' }),
    });
    assert(chalRes.status === 200, `Challenge failed: ${chalRes.status}`);
    const { nonce } = (await chalRes.json()) as { nonce: string };
    assert(/^[a-f0-9]{64}$/.test(nonce), `Expected 64-hex attestation nonce, got length=${nonce.length}`);

    const deviceId = `dev-device-${randomUUID().slice(0, 12)}`;
    const attPayload = {
      platform: 'android',
      provider: 'play_integrity_standard',
      deviceId,
      appId: 'ge.ertad.mobile',
      nonce,
      token: `dev-attest-${randomUUID()}`,
      counter: 1,
    };
    const attOk = await fetch(`${base}/mobile/m4/attestation/verify`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify(attPayload),
    });
    assert(attOk.status === 200, `Attestation verify failed: ${attOk.status}`);
    const attBody = (await attOk.json()) as { bindingId: string };

    // Replay of same nonce must fail
    const attReplay = await fetch(`${base}/mobile/m4/attestation/verify`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify(attPayload),
    });
    assert(attReplay.status === 403, `Expected 403 on nonce replay, got ${attReplay.status}`);

    const gBind = await fetch(`${base}/mobile/m4/google/bind`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({ idToken: `dev-google-sub:${randomUUID()}` }),
    });
    assert(gBind.status === 200, `Google bind failed: ${gBind.status}`);

    // Low liveness score must fail
    const bioFail = await fetch(`${base}/mobile/m4/biometric/complete`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({
        deviceId,
        sodCscaVerified: true,
        citizenshipCountry: 'GE',
        livenessScore: 0.45,
        faceMatchScore: 0.91,
        personSubjectKey: `person-key-${randomUUID()}`,
      }),
    });
    assert(bioFail.status === 403, `Expected 403 on low liveness, got ${bioFail.status}`);

    // Valid eID completion succeeds (including >16KB portrait payload, ISO-3 'GEO', 54% ArcFace similarity)
    const sharedPersonKey = `person-key-${randomUUID()}`;
    const sampleTemplate = `ertad-tpl-v1:${randomUUID()}`;
    const samplePortrait = Buffer.from('synthetic-eid-portrait-jpeg-test-bytes-'.repeat(700)).toString('base64');
    const bioOk = await fetch(`${base}/mobile/m4/biometric/complete`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({
        deviceId,
        sodCscaVerified: true,
        citizenshipCountry: 'GEO',
        livenessScore: 0.94,
        faceMatchScore: 0.54,
        personSubjectKey: sharedPersonKey,
        biometricTemplate: sampleTemplate,
        docPortraitBase64: samplePortrait,
      }),
    });
    assert(bioOk.status === 200, `Valid eID complete failed: ${bioOk.status}`);

    // Verify /status reports stored encrypted biometric template & portrait without leaking cipher
    const statusAfterBio = (await (await fetch(`${base}/mobile/m4/status`, { headers: mHeaders })).json()) as {
      hasStoredTemplate?: boolean;
      hasPortrait?: boolean;
      assuranceLevel?: string;
    };
    assert(statusAfterBio.hasStoredTemplate === true, 'Expected hasStoredTemplate=true after biometric completion');
    assert(statusAfterBio.hasPortrait === true, 'Expected hasPortrait=true after biometric completion');
    assert(statusAfterBio.assuranceLevel === 'biometric_verified', 'Expected assuranceLevel=biometric_verified');

    // Re-authentication against stored encrypted biometric template
    const reauthLow = await fetch(`${base}/mobile/m4/biometric/reauth`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({
        livenessScore: 0.40,
        faceMatchScore: 0.93,
      }),
    });
    assert(reauthLow.status === 403, `Expected 403 on low liveness reauth, got ${reauthLow.status}`);

    const reauthOk = await fetch(`${base}/mobile/m4/biometric/reauth`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({
        livenessScore: 0.95,
        faceMatchScore: 0.93,
      }),
    });
    assert(reauthOk.status === 200, `Biometric reauth failed: ${reauthOk.status}`);
    const reauthJson = (await reauthOk.json()) as { reauthenticated: boolean };
    assert(reauthJson.reauthenticated === true, 'Expected reauthenticated=true');

    // 3b. Permanent verification & new-device selfie-only re-auth + profile history
    const newDeviceId = 'dev-device-new-99';
    const newDevStatusBefore = await fetch(
      `${base}/mobile/m4/status?deviceId=${encodeURIComponent(newDeviceId)}`,
      { headers: mHeaders }
    );
    assert(newDevStatusBefore.status === 200, `New-device status failed: ${newDevStatusBefore.status}`);
    const beforeBody = (await newDevStatusBefore.json()) as {
      assuranceLevel: string;
      permanentVerification: boolean;
      deviceTrusted: boolean;
      needsSelfieReauth: boolean;
    };
    assert(beforeBody.assuranceLevel === 'biometric_verified', 'Expected permanent biometric assurance');
    assert(beforeBody.permanentVerification === true, 'Expected permanentVerification=true');
    assert(beforeBody.deviceTrusted === false, 'Expected new device to be untrusted initially');
    assert(beforeBody.needsSelfieReauth === true, 'Expected needsSelfieReauth=true on unrecognized device');

    const newDevReauth = await fetch(`${base}/mobile/m4/biometric/reauth`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({
        deviceId: newDeviceId,
        platform: 'android',
        appId: 'ge.ertad.mobile',
        livenessScore: 0.96,
        faceMatchScore: 0.92,
      }),
    });
    assert(newDevReauth.status === 200, `New-device selfie reauth failed: ${newDevReauth.status}`);
    const newDevReauthJson = (await newDevReauth.json()) as {
      reauthenticated: boolean;
      deviceTrusted?: boolean;
    };
    assert(newDevReauthJson.reauthenticated === true, 'Expected new-device reauthenticated=true');
    assert(newDevReauthJson.deviceTrusted === true, 'Expected deviceTrusted=true in reauth response');

    const newDevStatusAfter = await fetch(
      `${base}/mobile/m4/status?deviceId=${encodeURIComponent(newDeviceId)}`,
      { headers: mHeaders }
    );
    assert(newDevStatusAfter.status === 200, `New-device status-after failed: ${newDevStatusAfter.status}`);
    const afterBody = (await newDevStatusAfter.json()) as {
      permanentVerification: boolean;
      deviceTrusted: boolean;
      needsSelfieReauth: boolean;
      activeDeviceCount: number;
    };
    assert(afterBody.permanentVerification === true, 'Expected permanentVerification=true after reauth');
    assert(afterBody.deviceTrusted === true, 'Expected new device trusted after selfie reauth');
    assert(afterBody.needsSelfieReauth === false, 'Expected needsSelfieReauth=false after selfie reauth');
    assert(afterBody.activeDeviceCount >= 2, `Expected >=2 trusted devices, got ${afterBody.activeDeviceCount}`);

    const profileHistRes = await fetch(`${base}/mobile/m4/profile`, { headers: mHeaders });
    assert(profileHistRes.status === 200, `Profile history fetch failed: ${profileHistRes.status}`);
    const profileHist = (await profileHistRes.json()) as {
      permanentVerification: boolean;
      devices: Array<Record<string, unknown>>;
      verificationHistory: Array<Record<string, unknown>>;
      identityStats: Record<string, unknown>;
    };
    assert(profileHist.permanentVerification === true, 'Expected profile permanentVerification=true');
    assert(
      Array.isArray(profileHist.devices) && profileHist.devices.length >= 2,
      'Expected profile devices list with >=2 devices'
    );
    assert(
      Array.isArray(profileHist.verificationHistory) && profileHist.verificationHistory.length >= 2,
      'Expected profile verificationHistory with enrollment and reauth events'
    );
    assert(
      profileHist.identityStats &&
        typeof profileHist.identityStats.pointsBalance === 'number' &&
        typeof profileHist.identityStats.tasksCompleted === 'number' &&
        typeof profileHist.identityStats.votesCast === 'number' &&
        typeof profileHist.identityStats.referralsCount === 'number',
      'Expected numeric identityStats counters on profile'
    );

    // 4. Operator holds device -> member eID on held device is blocked -> release & purge biometrics
    const holdRes = await fetch(`${base}/admin/platform/verification/devices/control`, {
      method: 'POST',
      headers: approverHeaders,
      body: JSON.stringify({ op: 'hold', bindingId: attBody.bindingId, reason: 'suspected_compromise' }),
    });
    assert(holdRes.status === 200, `Device hold failed: ${holdRes.status}`);

    const heldTry = await fetch(`${base}/mobile/m4/biometric/complete`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({
        deviceId,
        sodCscaVerified: true,
        citizenshipCountry: 'GE',
        livenessScore: 0.95,
        faceMatchScore: 0.95,
        personSubjectKey: sharedPersonKey,
      }),
    });
    assert(heldTry.status === 403, `Expected 403 for held device, got ${heldTry.status}`);

    const releaseRes = await fetch(`${base}/admin/platform/verification/devices/control`, {
      method: 'POST',
      headers: approverHeaders,
      body: JSON.stringify({ op: 'release', bindingId: attBody.bindingId }),
    });
    assert(releaseRes.status === 200, `Device release failed: ${releaseRes.status}`);

    // Second persona cannot reuse same personSubjectKey (person-level uniqueness)
    const gLogin = (await (await fetch(`${base}/mobile/dev/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personaId: manager.id }),
    })).json()) as { sessionToken: string; csrfToken: string };
    const gHeaders = {
      Authorization: `Bearer ${gLogin.sessionToken}`,
      'X-Mobile-CSRF': gLogin.csrfToken,
      'Content-Type': 'application/json',
    };
    const chal2 = (await (await fetch(`${base}/mobile/m4/attestation/challenge`, {
      method: 'POST',
      headers: gHeaders,
      body: JSON.stringify({ platform: 'android' }),
    })).json()) as { nonce: string };
    const dev2 = `dev-device-${randomUUID().slice(0, 12)}`;
    await fetch(`${base}/mobile/m4/attestation/verify`, {
      method: 'POST',
      headers: gHeaders,
      body: JSON.stringify({
        platform: 'android',
        provider: 'play_integrity_standard',
        deviceId: dev2,
        appId: 'ge.ertad.mobile',
        nonce: chal2.nonce,
        token: `dev-attest-${randomUUID()}`,
        counter: 1,
      }),
    });
    const dupBio = await fetch(`${base}/mobile/m4/biometric/complete`, {
      method: 'POST',
      headers: gHeaders,
      body: JSON.stringify({
        deviceId: dev2,
        sodCscaVerified: true,
        citizenshipCountry: 'GE',
        livenessScore: 0.94,
        faceMatchScore: 0.92,
        personSubjectKey: sharedPersonKey,
      }),
    });
    assert(dupBio.status === 409, `Expected 409 duplicate person proof, got ${dupBio.status}`);

    const purgeRes = await fetch(`${base}/admin/platform/verification/devices/control`, {
      method: 'POST',
      headers: approverHeaders,
      body: JSON.stringify({ op: 'purge_biometrics' }),
    });
    assert(purgeRes.status === 200, `Purge biometrics failed: ${purgeRes.status}`);

    // 5. Personal Referral Hierarchy check (summary + self-referral blocked)
    const orgRow = await ownerPool.query<{ id: string }>('SELECT id FROM ertad.organizations LIMIT 1');
    const orgId = orgRow.rows[0]?.id;
    if (orgId) {
      const refSum = await fetch(`${base}/mobile/m4/referrals/summary?organizationId=${orgId}`, { headers: mHeaders });
      assert(refSum.status === 200, `Referral summary failed: ${refSum.status}`);
      const refBody = (await refSum.json()) as { personalCode: string; directCount: number; networkTotalCount: number };
      assert(/^ERTAD-P-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(refBody.personalCode), `Unexpected personal referral code: ${refBody.personalCode}`);

      const selfRef = await fetch(`${base}/mobile/m4/referrals/redeem`, {
        method: 'POST',
        headers: mHeaders,
        body: JSON.stringify({ organizationId: orgId, code: refBody.personalCode }),
      });
      assert(selfRef.status === 403, `Expected 403 on self-referral, got ${selfRef.status}`);
    }

    // 6. Technical Admin External Integrations (Two-Person Propose -> Approve) & Mobile Opt-In Channels
    const intRead = await fetch(`${base}/admin/platform/verification/integrations`, { headers: readerHeaders });
    assert(intRead.status === 200, `Integrations read failed: ${intRead.status}`);
    const intBody = (await intRead.json()) as {
      providers: Array<{ provider: string; version: number; enabled: boolean; hasSecret: boolean }>;
    };
    const tgBefore = intBody.providers.find((p) => p.provider === 'telegram_bot');
    assert(tgBefore, 'Expected telegram_bot provider row');

    const intProp = await fetch(`${base}/admin/platform/verification/integrations/propose`, {
      method: 'POST',
      headers: proposerHeaders,
      body: JSON.stringify({
        requestId: randomUUID(),
        provider: 'telegram_bot',
        expectedVersion: tgBefore.version,
        enabled: true,
        publicConfig: { botUsername: '@ertad_notify_bot' },
        secret: '123456:TEST-TELEGRAM-SECRET-TOKEN',
        reason: 'Enable Telegram notifications for opt-in members',
      }),
    });
    assert(intProp.status === 200, `Integration propose failed: ${intProp.status}`);
    const intPropJson = (await intProp.json()) as { proposalId: string };

    const intSelfApprove = await fetch(`${base}/admin/platform/verification/integrations/review`, {
      method: 'POST',
      headers: proposerHeaders,
      body: JSON.stringify({ requestId: randomUUID(), proposalId: intPropJson.proposalId, action: 'approve' }),
    });
    assert(intSelfApprove.status === 403, `Expected 403 on integration self-approve, got ${intSelfApprove.status}`);

    const intApprove = await fetch(`${base}/admin/platform/verification/integrations/review`, {
      method: 'POST',
      headers: approverHeaders,
      body: JSON.stringify({ requestId: randomUUID(), proposalId: intPropJson.proposalId, action: 'approve' }),
    });
    assert(intApprove.status === 200, `Integration approve failed: ${intApprove.status}`);

    const chSet = await fetch(`${base}/mobile/m4/channels`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({ channel: 'telegram', enabled: true, handle: '@member_demo_handle' }),
    });
    assert(chSet.status === 200, `Mobile channel update failed: ${chSet.status}`);
    const chBody = (await chSet.json()) as {
      channels: Array<{ channel: string; platformEnabled: boolean; enabled: boolean; handleHint: string }>;
    };
    const tgCh = chBody.channels.find((c) => c.channel === 'telegram');
    assert(tgCh?.platformEnabled === true && tgCh.enabled === true && tgCh.handleHint.includes('***'), 'Expected enabled Telegram channel with masked handle hint');

    // 7. Member Profile & Encrypted Phone Number
    const phoneSave = await fetch(`${base}/mobile/m4/profile/phone`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({ phone: '+995 599 12 34 56' }),
    });
    assert(phoneSave.status === 200, `Profile phone save failed: ${phoneSave.status}`);
    const profBody = (await phoneSave.json()) as { hasPhone: boolean; phoneHint: string; citizenshipCountry: string };
    assert(profBody.hasPhone === true && profBody.phoneHint.includes('***') && !profBody.phoneHint.includes('599123456'), 'Expected masked phone hint');

    const phoneClear = await fetch(`${base}/mobile/m4/profile/phone`, {
      method: 'POST',
      headers: mHeaders,
      body: JSON.stringify({ clear: true }),
    });
    assert(phoneClear.status === 200, `Profile phone clear failed: ${phoneClear.status}`);

    await fetch(`${base}/mobile/dev/logout`, { method: 'POST', headers: mHeaders });
    await fetch(`${base}/mobile/dev/logout`, { method: 'POST', headers: gHeaders });

    console.log('PASS test-m4-verification (Read vs Control, Two-Person Approval, Attestation Replay Guard, eID Biometrics, Template Reauth, Person Uniqueness, Device Hold, Personal Referrals, Technical Integrations & Opt-In Channels)');
  } finally {
    // Clean up test-created proposals/proofs/operators cleanly so dev member stays unverified for manual testing
    await ownerPool.query('DELETE FROM ertad.platform_integration_proposals WHERE proposer_id = ANY($1::uuid[])', [createdAdmins]).catch(() => {});
    await ownerPool.query(
      `DELETE FROM ertad.member_identity_proofs WHERE member_id IN (
        SELECT mu.id FROM ertad.member_users mu
        JOIN ertad.admin_users au ON au.id = mu.web_account_id
        WHERE au.email LIKE '%@mobile.ertad.local'
      )`
    ).catch(() => {});
    await ownerPool.query(
      `DELETE FROM ertad.mobile_device_bindings WHERE device_id LIKE 'dev-device-%'`
    ).catch(() => {});
    await ownerPool.query('DELETE FROM ertad.verification_infrastructure_proposals WHERE proposer_id = ANY($1::uuid[])', [createdAdmins]).catch(() => {});
    await ownerPool.query('DELETE FROM ertad.platform_accounts WHERE admin_user_id = ANY($1::uuid[])', [createdAdmins]).catch(() => {});
    await ownerPool.query('DELETE FROM ertad.admin_users WHERE id = ANY($1::uuid[])', [createdAdmins]).catch(() => {});
    server.close();
    await ownerPool.end();
    await close();
  }
}

run().catch((err) => {
  console.error('M4 VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
