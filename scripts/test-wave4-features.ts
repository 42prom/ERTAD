import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { encode as encodeCbor } from "cbor-x";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_wave4_test_${randomBytes(8).toString("hex")}`,
  port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
const config = {
  host: "127.0.0.1",
  port,
  user: "ertad_owner",
  password: process.env.POSTGRES_PASSWORD,
};
const control = new pg.Client({ ...config, database: "ertad" }),
  owner = new pg.Client({
    ...config,
    database,
    options: "-c search_path=ertad,public",
  });
process.env.NODE_ENV = "test";
process.env.ERTAD_WEB_DEMO = "true";
process.env.API_KEY_ENCRYPTION_SECRET = randomBytes(32).toString("base64url");
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;
let created = false,
  connected = false,
  close: (() => Promise<void>) | undefined,
  checks = 0;
const origin = "http://localhost:15173",
  base = "/api/v1/admin";

async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log(`PASS ${name}`);
}

function base32ToBuffer(b32: string): Buffer {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of b32.toUpperCase().replace(/=+$/g, "")) {
    const idx = alpha.indexOf(ch);
    assert(idx >= 0);
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCodeNow(secret: string): string {
  const counter = BigInt(Math.floor(Date.now() / 30_000));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", base32ToBuffer(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

await control.connect();
try {
  await control.query(`CREATE DATABASE ${database}`);
  created = true;
  execFileSync(
    process.execPath,
    ["--import", "tsx", "backend/src/migrate.ts"],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: `postgresql://ertad_owner:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:${port}/${database}`,
      },
    },
  );
  await owner.connect();
  connected = true;
  const db = await import("../backend/src/db/client");
  close = db.close;
  const { seedWebDemo } = await import("./web-demo-fixture"),
    { enableDemoWork } = await import("./web-demo-work"),
    { seedPlatformOperator } = await import("./platform-fixture");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await enableDemoWork(owner, access);
  const technical = await seedPlatformOperator(owner);
  await owner.query("COMMIT");
  const savedTechnical = {
    ...technical,
    validUntil: new Date(technical.validUntil).toISOString(),
  };

  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin"),
    { createAdminAuthRouter } = await import("../backend/src/routes/admin/auth");

  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, storage: async () => {} },
    pino({ level: "silent" }),
    origin,
    createLocalAdminRouter(
      origin,
      () => access,
      () => savedTechnical,
    ),
  );

  // Strict MFA router sharing same origin to test real recovery-code login when MFA required
  const strictApp = createApp(
    { postgres: async () => {}, redis: async () => {}, storage: async () => {} },
    pino({ level: "silent" }),
    origin,
    createAdminAuthRouter({ requireMfa: true, allowedOrigins: [origin] }),
  );

  const council1 = request.agent(app);
  const login = await council1
    .post(base + "/demo/login")
    .set("Origin", origin)
    .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0")
    .send({ accountId: access.accounts[0].id })
    .expect(200);
  const csrf = login.body.csrfToken as string;

  await check(
    "interactive TOTP enrollment issues single-use recovery codes and enforces strict MFA login",
    async () => {
      // Without step-up, totp/setup fails with 428
      await council1
        .post(base + "/auth/security/totp/setup")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({})
        .expect(428);

      await council1
        .post(base + "/demo/step-up")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({})
        .expect(200);

      const started = await council1
        .post(base + "/auth/security/totp/setup")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({})
        .expect(200);
      assert.match(started.body.secret, /^[A-Z2-7]{32}$/);
      assert.ok(started.body.otpauthUri.startsWith("otpauth://totp/"));

      // Invalid code rejected
      await council1
        .post(base + "/auth/security/totp/confirm")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({ code: "000000" })
        .expect(400);

      const liveCode = totpCodeNow(started.body.secret);
      const confirmed = await council1
        .post(base + "/auth/security/totp/confirm")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({ code: liveCode })
        .expect(200);
      assert.equal(confirmed.body.enabled, true);
      assert.equal(confirmed.body.recoveryCodes.length, 8);
      assert.equal(confirmed.body.recoveryRemaining, 8);

      const status = await council1
        .get(base + "/auth/security/totp")
        .expect(200);
      assert.equal(status.body.enabled, true);
      assert.equal(status.body.recoveryRemaining, 8);

      // Login on strict MFA router using one recovery code works ONCE and rejects replay
      const recovery = confirmed.body.recoveryCodes[0] as string;
      const strictLogin = await request(strictApp)
        .post("/api/v1/admin/login")
        .set("Origin", origin)
        .send({
          email: access.accounts[0].email,
          password: access.accounts[0].password,
          totpCode: recovery,
        })
        .expect(200);
      assert.ok(strictLogin.body.csrfToken);

      await request(strictApp)
        .post("/api/v1/admin/login")
        .set("Origin", origin)
        .send({
          email: access.accounts[0].email,
          password: access.accounts[0].password,
          totpCode: recovery,
        })
        .expect(401);
    },
  );

  await check(
    "FIDO2/WebAuthn passkey registration, discoverable login, signCount anti-replay, and coarse clientLabel",
    async () => {
      // Ensure active session exposes coarse normalized browser label without raw UA
      const sessRes = await council1
        .get(base + "/auth/security/sessions")
        .expect(200);
      assert.ok(typeof sessRes.body.items[0].clientLabel === "string");

      const regOptions = await council1
        .post(base + "/auth/security/passkeys/register/options")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({ label: "YubiKey 5C Test" })
        .expect(200);
      assert.equal(regOptions.body.rp.id, "localhost");

      const { privateKey, publicKey } = generateKeyPairSync("ec", {
        namedCurve: "P-256",
      });
      const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
      const coseMap = new Map<number, unknown>([
        [1, 2], // EC2
        [3, -7], // ES256
        [-1, 1], // P-256
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]);
      const coseBytes = Buffer.from(encodeCbor(coseMap));
      const rpHash = createHash("sha256").update("localhost").digest();
      const credIdBuf = randomBytes(32);
      const credId = credIdBuf.toString("base64url");
      const aaguid = Buffer.alloc(16, 0);
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16BE(credIdBuf.length);
      const flagsAndCounter = Buffer.alloc(5);
      flagsAndCounter[0] = 0x01 | 0x40; // UP + AT
      flagsAndCounter.writeUInt32BE(1, 1);

      const authDataReg = Buffer.concat([
        rpHash,
        flagsAndCounter,
        aaguid,
        lenBuf,
        credIdBuf,
        coseBytes,
      ]);
      const attestationObject = Buffer.from(
        encodeCbor({ fmt: "none", attStmt: {}, authData: authDataReg }),
      ).toString("base64url");
      const clientDataReg = Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: regOptions.body.challenge,
          origin,
        }),
      ).toString("base64url");

      const createdPk = await council1
        .post(base + "/auth/security/passkeys/register/verify")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({
          challengeId: regOptions.body.challengeId,
          label: "YubiKey 5C Test",
          clientDataJSON: clientDataReg,
          attestationObject,
          transports: ["usb"],
        })
        .expect(201);
      assert.equal(createdPk.body.label, "YubiKey 5C Test");

      const listPk = await council1
        .get(base + "/auth/security/passkeys")
        .expect(200);
      assert.equal(listPk.body.items.length, 1);
      assert.equal(listPk.body.items[0].algorithm, -7);
      assert.equal("publicKeySpki" in listPk.body.items[0], false);

      // Now log in via WebAuthn assertion (discoverable, zero password!)
      const loginAgent = request.agent(app);
      const loginOpts = await loginAgent
        .post(base + "/auth/passkey/login/options")
        .set("Origin", origin)
        .send({})
        .expect(200);

      const signAssertion = (challenge: string, signCount: number) => {
        const clientDataJson = Buffer.from(
          JSON.stringify({
            type: "webauthn.get",
            challenge,
            origin,
          }),
        );
        const ad = Buffer.alloc(37);
        rpHash.copy(ad, 0);
        ad[32] = 0x01;
        ad.writeUInt32BE(signCount, 33);
        const signedPayload = Buffer.concat([
          ad,
          createHash("sha256").update(clientDataJson).digest(),
        ]);
        const sig = createSign("SHA256").update(signedPayload).sign(privateKey);
        return {
          clientDataJSON: clientDataJson.toString("base64url"),
          authenticatorData: ad.toString("base64url"),
          signature: sig.toString("base64url"),
        };
      };

      const assertion1 = signAssertion(loginOpts.body.challenge, 5);
      const pkLogin = await loginAgent
        .post(base + "/auth/passkey/login/verify")
        .set("Origin", origin)
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0")
        .send({
          challengeId: loginOpts.body.challengeId,
          credentialId: credId,
          ...assertion1,
        })
        .expect(200);
      assert.equal(pkLogin.body.user.email, access.accounts[0].email);
      const pkSessions = await loginAgent
        .get(base + "/auth/security/sessions")
        .expect(200);
      assert.equal(
        pkSessions.body.items.find((s: { current: boolean }) => s.current)?.clientLabel,
        "Chrome / Windows",
      );

      // Replaying stale signCount <= 5 MUST fail
      const loginOpts2 = await loginAgent
        .post(base + "/auth/passkey/login/options")
        .set("Origin", origin)
        .send({})
        .expect(200);
      const staleAssertion = signAssertion(loginOpts2.body.challenge, 4);
      await loginAgent
        .post(base + "/auth/passkey/login/verify")
        .set("Origin", origin)
        .send({
          challengeId: loginOpts2.body.challengeId,
          credentialId: credId,
          ...staleAssertion,
        })
        .expect(401);

      // Passkey step-up works with monotonically advancing signCount (6)
      const suOpts = await loginAgent
        .post(base + "/auth/passkey/step-up/options")
        .set("Origin", origin)
        .set("X-Admin-Csrf", pkLogin.body.csrfToken)
        .send({})
        .expect(200);
      const suAssertion = signAssertion(suOpts.body.challenge, 6);
      const suDone = await loginAgent
        .post(base + "/auth/passkey/step-up/verify")
        .set("Origin", origin)
        .set("X-Admin-Csrf", pkLogin.body.csrfToken)
        .send({
          challengeId: suOpts.body.challengeId,
          credentialId: credId,
          ...suAssertion,
        })
        .expect(200);
      assert.ok(suDone.body.expiresAt);
    },
  );

  await check(
    "opt-in notification preferences default false and sync idempotent outbox reminders",
    async () => {
      const initial = await council1
        .get(base + "/auth/security/notifications")
        .expect(200);
      assert.equal(initial.body.preferences.eventReminders, false);
      assert.equal(initial.body.preferences.taskDeadlines, false);

      // Create open event starting in 6 hours + open task due in 6 hours
      await council1
        .post(base + "/work/event_create")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({
          organizationId: access.organizationId,
          key: randomUUID(),
          unitId: access.accounts[0].unitId,
          title: "Outbox Reminder Event",
          description: "Upcoming event within 48h",
          location: "Tbilisi",
          startsAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
          endsAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
          contributionRuleId: null,
        })
        .expect(200);

      // Opt in to event reminders
      const updated = await council1
        .post(base + "/auth/security/notifications")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({ eventReminders: true })
        .expect(200);
      assert.equal(updated.body.preferences.eventReminders, true);

      const synced1 = await council1
        .post(base + "/auth/security/notifications/sync")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({})
        .expect(200);
      assert.equal(synced1.body.newlyQueued, 1);
      assert.equal(synced1.body.recentQueued[0].kind, "event_reminder_48h");

      // Idempotent second sync creates 0 duplicates
      const synced2 = await council1
        .post(base + "/auth/security/notifications/sync")
        .set("Origin", origin)
        .set("X-Admin-Csrf", csrf)
        .send({})
        .expect(200);
      assert.equal(synced2.body.newlyQueued, 0);
    },
  );

  await check(
    "persisted 24h security telemetry, Prometheus /metrics endpoint, and audit SHA-256 hash-chain verifier",
    async () => {
      const tech = request.agent(app);
      await tech
        .post(base + "/demo/login")
        .set("Origin", origin)
        .send({ accountId: technical.id })
        .expect(200);

      // Non-technical account denied on /metrics and /audit/verify
      await council1.get(base + "/platform/metrics").expect(403);
      await council1.get(base + "/platform/audit/verify").expect(403);

      const mon24h = await tech
        .get(base + "/platform/monitoring?minutes=1440")
        .expect(200);
      assert.equal(mon24h.body.retention, "persisted_database_72_hours");
      assert(mon24h.body.totals.access_denied >= 1);

      const metrics = await tech.get(base + "/platform/metrics").expect(200);
      assert.match(metrics.text, /ertad_security_signals_total/);
      assert.match(metrics.text, /ertad_http_responses_total/);

      const chain = await tech.get(base + "/platform/audit/verify").expect(200);
      assert.equal(chain.body.unbroken, true);
      assert(chain.body.verifiedCount >= 5);
      assert.match(chain.body.headHash, /^[0-9a-f]{64}$/);
      assert.match(chain.body.manifestDigest, /^[0-9a-f]{64}$/);
    },
  );

  console.log(`ALL ${checks} wave4 checks passed`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) {
    await control.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [database],
    );
    await control.query(`DROP DATABASE IF EXISTS ${database}`);
  }
  await control.end();
}

