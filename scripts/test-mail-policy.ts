import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";
loadEnvFile(".env");

const database = "ertad_mail_test_" + randomBytes(8).toString("hex");
const config = {
  host: "127.0.0.1",
  port: Number(process.env.ERTAD_POSTGRES_PORT ?? 15432),
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
process.env.DATABASE_URL =
  "postgresql://ertad_app:" +
  encodeURIComponent(process.env.APP_DB_PASSWORD!) +
  "@127.0.0.1:" +
  config.port +
  "/" +
  database;
let created = false,
  connected = false,
  close: (() => Promise<void>) | undefined,
  count = 0;
const origin = "http://localhost:15173",
  base = "/api/v1/admin";
const check = async (name: string, fn: () => Promise<void>) => {
  await fn();
  console.log("PASS " + name);
  count++;
};
await control.connect();
try {
  await control.query("CREATE DATABASE " + database);
  created = true;
  execFileSync(
    process.execPath,
    ["--import", "tsx", "backend/src/migrate.ts"],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL:
          "postgresql://ertad_owner:" +
          encodeURIComponent(process.env.POSTGRES_PASSWORD!) +
          "@127.0.0.1:" +
          config.port +
          "/" +
          database,
      },
    },
  );
  await owner.connect();
  connected = true;
  const db = await import("../backend/src/db/client");
  close = db.close;
  const {
    seedPlatformOperator,
    enablePlatformProviders,
    enablePlatformIntegrations,
  } = await import("./platform-fixture");
  const { seedWebDemo } = await import("./web-demo-fixture");
  await owner.query("BEGIN");
  const tech = await seedPlatformOperator(owner),
    reviewer = await seedPlatformOperator(owner, "reviewer"),
    demo = await seedWebDemo(owner);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin"),
    { createNetworkControl } =
      await import("../backend/src/modules/security/networkControl"),
    { platformCommand } =
      await import("../backend/src/modules/security/platform"),
    { SecurityService } = await import("../backend/src/services/security");
  const read = async () =>
    (await owner.query("SELECT ertad.current_network_policy() policy")).rows[0]
      .policy;
  const secret = randomBytes(32).toString("hex"),
    ipSecret = randomBytes(32).toString("hex");
  const network = createNetworkControl(secret, ipSecret, read, true);

  const readLimits = async () =>
    (await db.query("SELECT ertad.current_security_limits() policy")).rows[0]
      .policy;
  const makeApp = () =>
    createApp(
      {
        postgres: async () => {},
        redis: async () => {},
        storage: async () => {},
      },
      pino({ level: "silent" }),
      origin,
      createLocalAdminRouter(
        origin,
        () => demo,
        () => ({
          ...tech,
          validUntil: new Date(tech.validUntil).toISOString(),
        }),
      ),
      network,
      readLimits,
    );
  const app = makeApp(),
    operator = request.agent(app),
    review = request.agent(app),
    org = request.agent(app);
  async function login(agent: any, account: any) {
    return (
      await agent
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: account.email, password: account.password })
        .expect(200)
    ).body.csrfToken;
  }
  const csrf = await login(operator, tech),
    reviewCsrf = await login(review, reviewer);
  await login(org, demo.accounts[0]);
  const propose = (input: any) =>
    operator
      .post(base + "/platform/mail-policy/propose")
      .set("Origin", origin)
      .set("X-Admin-CSRF", csrf)
      .send(input);
  const inspect = (input: any) =>
    review
      .post(base + "/platform/mail-policy/review")
      .set("Origin", origin)
      .set("X-Admin-CSRF", reviewCsrf)
      .send(input);
  const input = (version = 0) => ({
    requestId: randomUUID(),
    expectedVersion: version,
    provider: "sendgrid",
    mode: "enabled",
    senderName: "ERTAD",
    senderEmail: "sender@example.invalid",
    apiKey: "synthetic-provider-key",
    reason: "security_tightening",
  });
  const reviewInput = (id: string, action = "approve") => ({
    requestId: randomUUID(),
    proposalId: id,
    action,
  });
  const identity = async (id: string) =>
    (
      await owner.query(
        'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1 ORDER BY created_at DESC LIMIT 1',
        [id],
      )
    ).rows[0];
  const denied = (p: Promise<unknown>, status = 403) =>
    assert.rejects(p, (e: any) => e.statusCode === status);

  await check(
    "separate grants, password confirmation, CSRF and preserved expiry",
    async () => {
      await operator.get(base + "/platform/mail-policy").expect(403);
      await org.get(base + "/platform/mail-policy").expect(403);
      const before = (
        await owner.query(
          "SELECT valid_until FROM platform_accounts WHERE admin_user_id=$1",
          [tech.id],
        )
      ).rows[0].valid_until;
      await owner.query("BEGIN");
      assert(await enablePlatformProviders(owner, tech.id));
      assert.equal(await enablePlatformProviders(owner, tech.id), false);
      await enablePlatformProviders(owner, reviewer.id, "reviewer");
      await enablePlatformIntegrations(owner, tech.id);
      await owner.query("COMMIT");
      assert.equal(
        (
          await owner.query(
            "SELECT valid_until FROM platform_accounts WHERE admin_user_id=$1",
            [tech.id],
          )
        ).rows[0].valid_until.toISOString(),
        before.toISOString(),
      );
      await operator
        .post(base + "/platform/mail-policy/propose")
        .set("Origin", origin)
        .send(input())
        .expect(403);
      await propose(input()).expect(428);
      for (const [agent, account, token] of [
        [operator, tech, csrf],
        [review, reviewer, reviewCsrf],
      ] as const)
        await agent
          .post(base + "/auth/step-up")
          .set("Origin", origin)
          .set("X-Admin-CSRF", token)
          .send({ password: account.password })
          .expect(200);
      for (const extra of [
        { provider: "mock" },
        { apiKey: "bad\nkey" },
        { url: "http://127.0.0.1" },
        { credentialCipher: "cipher" },
        { runtimeReady: true },
      ])
        await propose({ ...input(), ...extra }).expect(400);
    },
  );
  const firstInput = input();
  const first = (await propose(firstInput).expect(200)).body.id;
  const oldCipher = (
    await owner.query(
      "SELECT credential_cipher FROM mail_policy_proposals WHERE id=$1",
      [first],
    )
  ).rows[0].credential_cipher;
  await check(
    "encrypted credential, sanitized inventory and exact idempotent retry",
    async () => {
      const { decryptSensitiveValue } =
        await import("../backend/src/services/secretEncryption");
      assert.equal(decryptSensitiveValue(oldCipher), "synthetic-provider-key");
      assert(!oldCipher.includes("synthetic-provider-key"));
      const data = (
        await operator.get(base + "/platform/mail-policy").expect(200)
      ).body;
      assert.equal(data.current.version, 0);
      assert.equal(data.items[0].hasCredential, true);
      assert(!JSON.stringify(data).includes("credentialCipher"));
      assert(!JSON.stringify(data).includes("synthetic-provider-key"));
      assert.equal((await propose(firstInput).expect(200)).body.id, first);
      await propose({ ...firstInput, apiKey: "different-key" }).expect(409);
      const { apiKey: unused, ...withoutKey } = firstInput;
      await propose(withoutKey).expect(409);
    },
  );
  await check("independent approval and idempotent review", async () => {
    await operator
      .post(base + "/platform/mail-policy/review")
      .set("Origin", origin)
      .set("X-Admin-CSRF", csrf)
      .send(reviewInput(first))
      .expect(403);

    const approve = reviewInput(first);
    await inspect(approve).expect(200);
    await inspect(approve).expect(200);
    assert.equal(
      (await owner.query("SELECT ertad.current_mail_policy() policy")).rows[0]
        .policy.version,
      1,
    );
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int n FROM audit_log WHERE event_type='PLATFORM_MAIL_POLICY_REVIEWED'",
        )
      ).rows[0].n,
      1,
    );
  });
  await check(
    "sandbox diagnostic uses approved version and rechecks authority",
    async () => {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async (url, options) => {
        calls++;
        assert.equal(url, "https://api.sendgrid.com/v3/mail/send");
        assert.equal(
          JSON.parse(String(options?.body)).mail_settings.sandbox_mode.enable,
          true,
        );
        return new Response("", { status: 200 });
      };
      try {
        const diagnose = (version: number) =>
          operator
            .post(base + "/platform/mail-policy/check")
            .set("Origin", origin)
            .set("X-Admin-CSRF", csrf)
            .send({ expectedVersion: version });
        await diagnose(0).expect(409);
        assert.equal(calls, 0);
        assert.equal((await diagnose(1).expect(200)).body.status, "valid");
        assert.equal(calls, 1);
        globalThis.fetch = async () => {
          calls++;
          await owner.query(
            "UPDATE platform_accounts SET revoked_at=clock_timestamp() WHERE admin_user_id=$1",
            [tech.id],
          );
          return new Response("", { status: 200 });
        };
        await diagnose(1).expect(403);
        assert.equal(calls, 2);
      } finally {
        globalThis.fetch = original;
        await owner.query(
          "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
          [tech.id],
        );
      }
    },
  );
  await check(
    "version conflicts, key retention, clearing and no old-key resurrection",
    async () => {
      const { apiKey: unused, ...next } = input(1);
      const saved = (await propose({ ...next, mode: "off" }).expect(200)).body
        .id;
      assert.equal(
        (
          await owner.query(
            "SELECT credential_cipher FROM mail_policy_proposals WHERE id=$1",
            [saved],
          )
        ).rows[0].credential_cipher,
        oldCipher,
      );
      const stale = (
        await propose({ ...next, requestId: randomUUID(), mode: "off" }).expect(
          200,
        )
      ).body.id;
      await inspect(reviewInput(saved)).expect(200);
      await inspect(reviewInput(stale)).expect(409);
      await inspect(reviewInput(stale, "reject")).expect(200);
      const cleared = (
        await propose({
          ...next,
          requestId: randomUUID(),
          expectedVersion: 2,
          provider: "none",
          mode: "off",
        }).expect(200)
      ).body.id;
      await inspect(reviewInput(cleared)).expect(200);
      assert.equal(
        (await owner.query("SELECT ertad.current_mail_policy() policy")).rows[0]
          .policy.credentialCipher,
        null,
      );
      await propose({
        ...next,
        requestId: randomUUID(),
        expectedVersion: 3,
      }).expect(400);
    },
  );
  await check(
    "audit failure rolls back secret writes and revoked proposers cannot be approved",
    async () => {
      const original = SecurityService.logAuditEventInTransaction;
      const attempt = input(3);
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        payload,
      ) => {
        if (event === "PLATFORM_MAIL_POLICY_PROPOSED")
          throw Error("synthetic audit outage");
        return original(client, event, payload);
      };
      try {
        await assert.rejects(
          platformCommand(
            await identity(tech.id),
            "proposeMailPolicy",
            attempt,
          ),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM mail_policy_proposals WHERE request_id=$1",
            [attempt.requestId],
          )
        ).rows[0].n,
        0,
      );
      const pending = (await propose(attempt).expect(200)).body.id;
      await owner.query(
        "UPDATE platform_accounts SET revoked_at=clock_timestamp() WHERE admin_user_id=$1",
        [tech.id],
      );
      await inspect(reviewInput(pending)).expect(403);
      await owner.query(
        "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
        [tech.id],
      );
      await inspect(reviewInput(pending, "reject")).expect(200);
    },
  );
  await check(
    "expired proposals and post-audit revoked authority cannot commit",
    async () => {
      const expired = (await propose(input(3)).expect(200)).body.id;
      await owner.query(
        "UPDATE mail_policy_proposals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [expired],
      );
      await inspect(reviewInput(expired)).expect(409);
      const pending = (await propose(input(3)).expect(200)).body.id;
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        payload,
      ) => {
        await original(client, event, payload);
        if (event === "PLATFORM_MAIL_POLICY_REVIEWED")
          await client.query(
            "UPDATE platform_accounts SET revoked_at=clock_timestamp() WHERE admin_user_id=$1",
            [tech.id],
          );
      };
      try {
        await denied(
          platformCommand(
            await identity(reviewer.id),
            "reviewMailPolicy",
            reviewInput(pending),
          ),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM mail_policy_proposals WHERE id=$1",
            [pending],
          )
        ).rows[0].status,
        "pending",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM platform_accounts WHERE admin_user_id=$1",
            [tech.id],
          )
        ).rows[0].revoked_at,
        null,
      );
      await inspect(reviewInput(pending, "reject")).expect(200);
    },
  );
  await check(
    "runtime cannot read or mutate credential rows; audit excludes sender and key",
    async () => {
      for (const sql of [
        "SELECT * FROM ertad.mail_policy_proposals",
        "DELETE FROM ertad.mail_policy_proposals",
      ])
        await assert.rejects(
          db.query(sql),
          (error: { code?: string }) => error.code === "42501",
        );
      const events = (
        await owner.query(
          "SELECT row_to_json(a)::text AS body FROM audit_log a WHERE event_type LIKE 'PLATFORM_MAIL%'",
        )
      ).rows;
      assert(events.length > 0);
      for (const event of events) {
        assert(!event.body.includes("sender@example.invalid"));
        assert(!event.body.includes("synthetic-provider-key"));
        assert(!event.body.includes("credentialCipher"));
      }
      const policy = (
        await owner.query("SELECT ertad.current_mail_policy() policy")
      ).rows[0].policy;
      assert.equal(policy.mode, "off");
      assert.equal(policy.credentialCipher, null);
    },
  );
  if (process.argv.includes("--browser"))
    await (
      await import("./mail-browser")
    ).verifyMailBrowser(makeApp(), tech, reviewer);
  console.log(count + " mail configuration scenarios passed");
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created)
    await control.query("DROP DATABASE " + database + " WITH (FORCE)");
  await control.end();
}
