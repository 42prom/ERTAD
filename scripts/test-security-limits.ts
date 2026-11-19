import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";
loadEnvFile(".env");

const database = "ertad_limits_test_" + randomBytes(8).toString("hex");
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
  const { seedPlatformOperator, enablePlatformLimits } =
    await import("./platform-fixture");
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
      .post(base + "/platform/security-limits/propose")
      .set("Origin", origin)
      .set("X-Admin-CSRF", csrf)
      .send(input);
  const inspect = (input: any) =>
    review
      .post(base + "/platform/security-limits/review")
      .set("Origin", origin)
      .set("X-Admin-CSRF", reviewCsrf)
      .send(input);
  const input = (version = 0) => ({
    requestId: randomUUID(),
    expectedVersion: version,
    apiPerMinute: 60,
    loginFailures: 3,
    lockoutMinutes: 5,
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
  let first = "",
    stale = "";
  const firstInput = input();
  await check(
    "separate limits grants, unchanged account expiry, CSRF and password gates",
    async () => {
      await operator.get(base + "/platform/security-limits").expect(403);
      await org.get(base + "/platform/security-limits").expect(403);
      const before = (
        await owner.query(
          "SELECT valid_until FROM platform_accounts WHERE admin_user_id=$1",
          [tech.id],
        )
      ).rows[0].valid_until;
      await owner.query("BEGIN");
      assert.equal(await enablePlatformLimits(owner, tech.id), true);
      assert.equal(await enablePlatformLimits(owner, tech.id), false);
      await enablePlatformLimits(owner, reviewer.id, "reviewer");
      await owner.query("COMMIT");
      const grant = (
        await owner.query(
          "SELECT * FROM platform_accounts WHERE admin_user_id=$1",
          [tech.id],
        )
      ).rows[0];
      assert.equal(grant.valid_until.toISOString(), before.toISOString());
      assert(!grant.permissions.includes("platform.limits.approve"));
      assert.deepEqual(
        (await operator.get(base + "/platform/security-limits").expect(200))
          .body.current,
        {
          version: 0,
          apiPerMinute: 120,
          loginFailures: 5,
          lockoutMinutes: 15,
          anonymousMinElectorate: 10,
        },
      );
      await operator
        .post(base + "/platform/security-limits/propose")
        .set("Origin", origin)
        .send(firstInput)
        .expect(403);
      await propose(firstInput).expect(428);
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
      for (const invalid of [
        { apiPerMinute: 0 },
        { loginFailures: 11 },
        { lockoutMinutes: 4 },
        { apiPerMinute: 60.5 },
        { extra: true },
      ])
        await propose({ ...firstInput, ...invalid }).expect(400);
      await review
        .post(base + "/platform/security-limits/propose")
        .set("Origin", origin)
        .set("X-Admin-CSRF", reviewCsrf)
        .send(firstInput)
        .expect(403);
    },
  );
  await check(
    "proposals do not change live limits; independent approval and exact retries are enforced",
    async () => {
      first = (await propose(firstInput).expect(200)).body.id;
      stale = (await propose(input()).expect(200)).body.id;
      assert.equal((await readLimits()).version, 0);
      assert.equal((await propose(firstInput).expect(200)).body.id, first);
      await propose({ ...firstInput, apiPerMinute: 61 }).expect(409);
      await owner.query(
        "UPDATE platform_accounts SET permissions=array_append(permissions,'platform.limits.approve') WHERE admin_user_id=$1",
        [tech.id],
      );
      await operator
        .post(base + "/platform/security-limits/review")
        .set("Origin", origin)
        .set("X-Admin-CSRF", csrf)
        .send(reviewInput(first))
        .expect(403);
      const approval = reviewInput(first);
      await inspect(approval).expect(200);
      await inspect(approval).expect(200);
      assert.deepEqual(await readLimits(), {
        version: 1,
        apiPerMinute: 60,
        loginFailures: 3,
        lockoutMinutes: 5,
        anonymousMinElectorate: 10,
      });
      await inspect(reviewInput(stale)).expect(409);
      await inspect(reviewInput(stale, "reject")).expect(200);
      await assert.rejects(
        db.query(
          "UPDATE ertad.security_limits_proposals SET api_per_minute=600",
        ),
        (e: any) => e.code === "42501",
      );
      await assert.rejects(
        db.query("SELECT * FROM ertad.security_limits_proposals"),
        (e: any) => e.code === "42501",
      );
      const journal = (await operator.get(base + "/platform/audit").expect(200))
        .body.items;
      assert(
        journal.some(
          (row: any) => row.event === "PLATFORM_SECURITY_LIMITS_REVIEWED",
        ),
      );
    },
  );
  // Use fresh application instances only between scenarios, never during a budget assertion.
  await check(
    "approved API limits isolate trusted clients and retain counters across policy changes",
    async () => {
      const runtime = makeApp();
      const edge = (ip: string) =>
        request(runtime)
          .get("/api/v1/private")
          .set("Host", "ertad.test")
          .set("x-ertad-proxy-token", secret)
          .set("x-ertad-source", "cloudflare")
          .set("x-ertad-client-ip", ip)
          .set("x-ertad-country", "GE");
      for (let i = 0; i < 60; i++) await edge("192.0.2.10").expect(401);
      await edge("192.0.2.10").expect(429);
      await edge("192.0.2.11").expect(401);
      await request(runtime)
        .get("/api/v1/private")
        .set("Host", "ertad.test")
        .set("x-forwarded-for", "192.0.2.12")
        .expect(403);
      for (let i = 0; i < 60; i++)
        await edge("2001:db8:1234:5600::1").expect(401);
      await edge("2001:db8:1234:56ff::2").expect(429);
      const own = await identity(tech.id),
        other = await identity(reviewer.id);
      const raised = await platformCommand(own, "proposeSecurityLimits", {
        ...input(1),
        apiPerMinute: 62,
      });
      await platformCommand(
        other,
        "reviewSecurityLimits",
        reviewInput(raised.id),
      );
      await edge("192.0.2.10").expect(401);
      await edge("192.0.2.10").expect(429);
      const lower = await platformCommand(
        own,
        "proposeSecurityLimits",
        input(2),
      );
      await platformCommand(
        other,
        "reviewSecurityLimits",
        reviewInput(lower.id),
      );
      await edge("192.0.2.10").expect(429);
    },
  );
  await check(
    "account lockout survives address rotation and existing lockouts survive a policy change",
    async () => {
      const runtime = makeApp(),
        account = demo.accounts[1];
      const attempt = (ip: string, password: string) =>
        request(runtime)
          .post(base + "/auth/login")
          .set("Host", "ertad.test")
          .set("Origin", origin)
          .set("x-ertad-proxy-token", secret)
          .set("x-ertad-source", "cloudflare")
          .set("x-ertad-client-ip", ip)
          .set("x-ertad-country", "GE")
          .send({ email: account.email, password });
      for (let i = 1; i <= 3; i++)
        await attempt("192.0.2." + (30 + i), "incorrect").expect(401);
      const locked = (
        await owner.query(
          "SELECT failed_login_attempts,locked_until FROM admin_users WHERE id=$1",
          [account.id],
        )
      ).rows[0];
      assert.equal(locked.failed_login_attempts, 3);
      const remaining = locked.locked_until.getTime() - Date.now();
      assert(remaining > 290000 && remaining <= 300000);
      const own = await identity(tech.id),
        other = await identity(reviewer.id);
      const relaxed = await platformCommand(own, "proposeSecurityLimits", {
        ...input(3),
        apiPerMinute: 120,
        loginFailures: 5,
        lockoutMinutes: 15,
      });
      await platformCommand(
        other,
        "reviewSecurityLimits",
        reviewInput(relaxed.id),
      );
      await attempt("192.0.2.39", account.password).expect(401);
      assert.equal(
        (
          await owner.query(
            "SELECT locked_until FROM admin_users WHERE id=$1",
            [account.id],
          )
        ).rows[0].locked_until.toISOString(),
        locked.locked_until.toISOString(),
      );
    },
  );
  await check(
    "password confirmation uses the approved account threshold",
    async () => {
      const runtime = makeApp(),
        agent = request.agent(runtime),
        account = demo.accounts[2],
        token = await login(agent, account);
      for (let i = 0; i < 5; i++)
        await agent
          .post(base + "/auth/step-up")
          .set("Origin", origin)
          .set("X-Admin-CSRF", token)
          .send({ password: "incorrect" })
          .expect(401);
      const row = (
        await owner.query(
          "SELECT failed_login_attempts,locked_until FROM admin_users WHERE id=$1",
          [account.id],
        )
      ).rows[0];
      assert.equal(row.failed_login_attempts, 5);
      assert(row.locked_until > Date.now());
    },
  );
  await check(
    "review rechecks proposer authority and audit failure rolls back policy and receipt",
    async () => {
      const own = await identity(tech.id),
        other = await identity(reviewer.id);
      const candidate = await platformCommand(
        own,
        "proposeSecurityLimits",
        input(4),
      );
      await owner.query(
        "UPDATE platform_accounts SET revoked_at=clock_timestamp() WHERE admin_user_id=$1",
        [tech.id],
      );
      await denied(
        platformCommand(
          other,
          "reviewSecurityLimits",
          reviewInput(candidate.id),
        ),
      );
      await owner.query(
        "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
        [tech.id],
      );
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw Error("synthetic audit unavailable");
      };
      try {
        await assert.rejects(
          platformCommand(
            other,
            "reviewSecurityLimits",
            reviewInput(candidate.id),
          ),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal((await readLimits()).version, 4);
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM security_limits_proposals WHERE id=$1",
            [candidate.id],
          )
        ).rows[0].status,
        "pending",
      );
      await platformCommand(
        other,
        "reviewSecurityLimits",
        reviewInput(candidate.id, "reject"),
      );
      const expiring = await platformCommand(
        own,
        "proposeSecurityLimits",
        input(4),
      );
      const previous = (
        await owner.query(
          "SELECT valid_until FROM platform_accounts WHERE admin_user_id=$1",
          [reviewer.id],
        )
      ).rows[0].valid_until;
      let reached = false;
      // Expiry during the required audit must invalidate and roll back approval.
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        payload,
      ) => {
        await original(client, event, payload);
        if (event === "PLATFORM_SECURITY_LIMITS_REVIEWED") {
          reached = true;
          await new Promise((r) => setTimeout(r, 2200));
        }
      };
      await owner.query(
        "UPDATE platform_accounts SET valid_until=clock_timestamp()+interval '2 seconds' WHERE admin_user_id=$1",
        [reviewer.id],
      );
      try {
        await denied(
          platformCommand(
            other,
            "reviewSecurityLimits",
            reviewInput(expiring.id),
          ),
        );
        assert(reached);
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query(
          "UPDATE platform_accounts SET valid_until=$2 WHERE admin_user_id=$1",
          [reviewer.id, previous],
        );
      }
      assert.equal((await readLimits()).version, 4);
      await platformCommand(
        other,
        "reviewSecurityLimits",
        reviewInput(expiring.id, "reject"),
      );
    },
  );
  await check(
    "admin controls anonymous poll minimum electorate (k) via dual-approved policy without hardcoded threshold",
    async () => {
      assert.equal((await readLimits()).anonymousMinElectorate, 10);
      await propose({
        requestId: randomUUID(),
        expectedVersion: 4,
        apiPerMinute: 120,
        loginFailures: 5,
        lockoutMinutes: 15,
        anonymousMinElectorate: 1,
        reason: "traffic_adjustment",
      }).expect(400);
      const custom = await propose({
        requestId: randomUUID(),
        expectedVersion: 4,
        apiPerMinute: 120,
        loginFailures: 5,
        lockoutMinutes: 15,
        anonymousMinElectorate: 4,
        reason: "traffic_adjustment",
      }).expect(200);
      await inspect({
        requestId: randomUUID(),
        proposalId: custom.body.id,
        action: "approve",
      }).expect(200);
      const updated = await readLimits();
      assert.equal(updated.version, 5);
      assert.equal(updated.anonymousMinElectorate, 4);
    },
  );
  if (process.argv.includes("--browser"))
    await (
      await import("./limits-browser")
    ).verifyLimitsBrowser(makeApp(), tech, reviewer);
  console.log(count + " security limits scenarios passed");
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created)
    await control.query("DROP DATABASE " + database + " WITH (FORCE)");
  await control.end();
}
