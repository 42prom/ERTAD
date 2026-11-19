import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";
loadEnvFile(".env");
await (await import("./network-ingress-tests")).verifyNetworkIngress();
const database = "ertad_network_test_" + randomBytes(8).toString("hex");
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
  const { seedPlatformOperator, enablePlatformNetwork } =
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
  const app = createApp(
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
      () => ({ ...tech, validUntil: new Date(tech.validUntil).toISOString() }),
    ),
    network,
  );
  const operator = request.agent(app),
    review = request.agent(app),
    org = request.agent(app);
  async function login(agent: any, account: any) {
    await agent
      .post(base + "/auth/login")
      .set("Origin", origin)
      .send({ email: account.email, password: account.password })
      .expect(200);
    return (await agent.get(base + "/auth/me").expect(200)).body.csrfToken;
  }
  const csrf = await login(operator, tech),
    rcsrf = await login(review, reviewer);
  await org
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: demo.accounts[0].id })
    .expect(200);
  const post = (input: any) =>
    operator
      .post(base + "/platform/network-policy/propose")
      .set("Origin", origin)
      .set("X-Admin-CSRF", csrf)
      .send(input);
  const reviewPost = (input: any) =>
    review
      .post(base + "/platform/network-policy/review")
      .set("Origin", origin)
      .set("X-Admin-CSRF", rcsrf)
      .send(input);
  const off = { mode: "off", countries: [], blocked: [], exceptions: [] };
  const propose = (settings = off, expectedVersion = 0) => ({
    settings,
    expectedVersion,
    requestId: randomUUID(),
    reason: "security_tightening",
  });
  const reviewInput = (id: string, action = "approve") => ({
    proposalId: id,
    action,
    requestId: randomUUID(),
  });
  const identity = async (id: string) =>
    (
      await owner.query(
        'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
        [id],
      )
    ).rows[0];
  const failed = (promise: Promise<unknown>, status: number) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
  const step = async (agent: any, token: string, password: string) =>
    agent
      .post(base + "/auth/step-up")
      .set("Origin", origin)
      .set("X-Admin-CSRF", token)
      .send({ password })
      .expect(200);
  let first = "",
    stale = "",
    input: any;
  await check(
    "network access is capability separated, audited, and requires CSRF and fresh password",
    async () => {
      await request(app)
        .get(base + "/platform/network-policy")
        .expect(401);
      await org.get(base + "/platform/network-policy").expect(403);
      await operator.get(base + "/platform/network-policy").expect(403);
      const before = (
        await owner.query(
          "SELECT valid_until FROM platform_accounts WHERE admin_user_id=$1",
          [tech.id],
        )
      ).rows[0].valid_until;
      await owner.query("BEGIN");
      assert(await enablePlatformNetwork(owner, tech.id));
      assert(!(await enablePlatformNetwork(owner, tech.id)));
      await enablePlatformNetwork(owner, reviewer.id, "reviewer");
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
      const state = (
        await operator.get(base + "/platform/network-policy").expect(200)
      ).body;
      assert.equal(state.current.version, 0);
      assert.equal(state.source, "local");
      input = propose({ ...off, mode: "allow", countries: ["GE"] } as any);
      await post(input).expect(428);
      await step(operator, csrf, tech.password);
      await step(review, rcsrf, reviewer.password);
      await operator
        .post(base + "/platform/network-policy/propose")
        .set("Origin", origin)
        .send(input)
        .expect(403);
      await operator
        .post(base + "/platform/network-policy/propose")
        .set("Origin", "https://invalid.example")
        .set("X-Admin-CSRF", csrf)
        .send(input)
        .expect(403);
      await post({ ...input, settings: { ...off, rawIp: "192.0.2.1" } }).expect(
        400,
      );
      await post({ ...input, settings: { ...off, mode: "allow" } }).expect(400);
      first = (await post(input).expect(200)).body.id;
      stale = (await post(propose()).expect(200)).body.id;
    },
  );
  await check(
    "exact retries, independent review and version conflict prevent duplicated or self-approved changes",
    async () => {
      assert.equal((await post(input).expect(200)).body.id, first);
      await post({ ...input, reason: "recovery" }).expect(409);
      await owner.query(
        "UPDATE platform_accounts SET permissions=array_append(permissions,'platform.network.approve') WHERE admin_user_id=$1",
        [tech.id],
      );
      await failed(
        platformCommand(await identity(tech.id), "reviewNetworkPolicy", {
          ...reviewInput(first),
          countryReady: true,
        }),
        403,
      );
      await owner.query(
        "UPDATE platform_accounts SET permissions=array_remove(permissions,'platform.network.approve') WHERE admin_user_id=$1",
        [tech.id],
      );
      network.countryReady = false;
      await reviewPost({
        ...reviewInput(first),
        countryReady: true,
        source: { country: "GE", key: network.key("192.0.2.1") },
      }).expect(409);
      network.countryReady = true;
      const r = reviewInput(first);
      await reviewPost(r).expect(200);
      await reviewPost(r).expect(200);
      assert.equal((await read()).version, 1);
      await reviewPost(reviewInput(stale)).expect(409);
    },
  );
  await check(
    "effective country rules, IP blocks, exceptions, expiry and local recovery enforce real HTTP",
    async () => {
      const remote = (country: string, ip = "192.0.2.1") =>
        request(app)
          .get(base + "/auth/me")
          .set("Host", "edge.example")
          .set("x-ertad-proxy-token", secret)
          .set("x-ertad-source", "cloudflare")
          .set("x-ertad-country", country)
          .set("x-ertad-client-ip", ip);
      await remote("GE").expect(401);
      await remote("DE").expect(403);
      await remote("XX").expect(403);
      await request(app)
        .get(base + "/auth/me")
        .set("cf-ipcountry", "GE")
        .expect(403);
      const hashed = (
        await operator
          .post(base + "/platform/network-policy/address-key")
          .set("Origin", origin)
          .set("X-Admin-CSRF", csrf)
          .send({ address: "192.0.2.1" })
          .expect(200)
      ).body.key;
      assert.equal(hashed, network.key("::ffff:192.0.2.1"));
      const target = {
        key: hashed,
        until: new Date(Date.now() + 3600000).toISOString(),
      };
      const p = (
        await post(
          propose(
            {
              ...off,
              mode: "deny",
              countries: ["DE"],
              blocked: [target],
              exceptions: [target],
            } as any,
            1,
          ),
        ).expect(200)
      ).body.id;
      const ownReview = await identity(reviewer.id);
      await failed(
        platformCommand(ownReview, "reviewNetworkPolicy", {
          ...reviewInput(p),
          countryReady: true,
          source: { country: "GE", key: hashed },
        }),
        409,
      );
      await reviewPost(reviewInput(p)).expect(200);
      await remote("GE").expect(403);
      const q = (
        await post(
          propose(
            {
              ...off,
              mode: "deny",
              countries: ["DE"],
              exceptions: [target],
            } as any,
            2,
          ),
        ).expect(200)
      ).body.id;
      await reviewPost(reviewInput(q)).expect(200);
      await remote("DE").expect(401);
      await remote("DE", "192.0.2.2").expect(403);
      const expired = {
        ...target,
        until: new Date(Date.now() - 1000).toISOString(),
      };
      const r = (
        await post(
          propose(
            {
              ...off,
              mode: "deny",
              countries: ["DE"],
              exceptions: [expired],
            } as any,
            3,
          ),
        ).expect(200)
      ).body.id;
      await reviewPost(reviewInput(r)).expect(200);
      await remote("DE").expect(403);
      await operator.get(base + "/platform/network-policy").expect(200);
      const audit = (
        await owner.query(
          "SELECT payload FROM audit_log WHERE event_type LIKE 'PLATFORM_NETWORK_%'",
        )
      ).rows;
      assert(!JSON.stringify(audit).includes("192.0.2.1"));
      const tables = (
        await owner.query("SELECT settings FROM network_policy_proposals")
      ).rows;
      assert(!JSON.stringify(tables).includes("192.0.2.1"));
    },
  );
  await check(
    "audit failure rolls back mutations; revoked proposer and direct runtime writes are denied",
    async () => {
      const original = SecurityService.logAuditEventInTransaction;
      const before = (
        await owner.query(
          "SELECT count(*)::int n FROM network_policy_proposals",
        )
      ).rows[0].n;
      SecurityService.logAuditEventInTransaction = async () => {
        throw Error("synthetic audit unavailable");
      };
      try {
        await assert.rejects(
          platformCommand(
            await identity(tech.id),
            "proposeNetworkPolicy",
            propose(off, 4),
          ),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM network_policy_proposals",
          )
        ).rows[0].n,
        before,
      );
      const p = (await post(propose(off, 4)).expect(200)).body.id;
      await owner.query(
        "UPDATE platform_accounts SET revoked_at=now() WHERE admin_user_id=$1",
        [tech.id],
      );
      await reviewPost(reviewInput(p)).expect(403);
      await owner.query("BEGIN");
      assert(!(await enablePlatformNetwork(owner, tech.id)));
      await owner.query("COMMIT");
      await owner.query(
        "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
        [tech.id],
      );
      await reviewPost(reviewInput(p, "reject")).expect(200);
      const runtime = new pg.Client({
        ...config,
        database,
        user: "ertad_app",
        password: process.env.APP_DB_PASSWORD,
      });
      await runtime.connect();
      try {
        await assert.rejects(
          runtime.query(
            "UPDATE ertad.network_policy_proposals SET status='approved'",
          ),
          (e: any) => e.code === "42501",
        );
      } finally {
        await runtime.end();
      }
    },
  );
  await check(
    "rejection, withdrawal, stale and concurrent approvals preserve a single effective version",
    async () => {
      const a = (await post(propose(off, 4)).expect(200)).body.id,
        b = (await post(propose(off, 4)).expect(200)).body.id;
      const who = await identity(reviewer.id);
      const settled = await Promise.allSettled(
        [a, b].map((id) =>
          platformCommand(who, "reviewNetworkPolicy", {
            ...reviewInput(id),
            countryReady: true,
          }),
        ),
      );
      assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((await read()).version, 5);
      const pending = (await post(propose(off, 5)).expect(200)).body.id;
      await operator
        .post(base + "/platform/network-policy/review")
        .set("Origin", origin)
        .set("X-Admin-CSRF", csrf)
        .send(reviewInput(pending, "withdraw"))
        .expect(200);
      await reviewPost(reviewInput(pending)).expect(409);
    },
  );
  await check(
    "approval rechecks permission expiry after audit and rolls back effective version",
    async () => {
      const p = (await post(propose(off, 5)).expect(200)).body.id;
      const session = await identity(reviewer.id),
        original = SecurityService.logAuditEventInTransaction;
      const previous = (
        await owner.query(
          "SELECT valid_until FROM platform_accounts WHERE admin_user_id=$1",
          [reviewer.id],
        )
      ).rows[0].valid_until;
      await owner.query(
        "UPDATE platform_accounts SET valid_until=clock_timestamp()+interval '2 seconds' WHERE admin_user_id=$1",
        [reviewer.id],
      );
      let reached = false;
      SecurityService.logAuditEventInTransaction = async (
        client: any,
        event: string,
        payload: any,
      ) => {
        await original(client, event, payload);
        if (event === "PLATFORM_NETWORK_POLICY_REVIEWED") {
          reached = true;
          await new Promise((r) => setTimeout(r, 2500));
        }
      };
      try {
        await failed(
          platformCommand(session, "reviewNetworkPolicy", {
            ...reviewInput(p),
            countryReady: true,
          }),
          403,
        );
        assert(reached);
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query(
          "UPDATE platform_accounts SET valid_until=$2 WHERE admin_user_id=$1",
          [reviewer.id, previous],
        );
      }
      assert.equal((await read()).version, 5);
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM network_policy_proposals WHERE id=$1",
            [p],
          )
        ).rows[0].status,
        "pending",
      );
      await reviewPost(reviewInput(p, "reject")).expect(200);
    },
  );
  if (process.argv.includes("--browser"))
    await (
      await import("./network-browser")
    ).verifyNetworkBrowser(app, tech, reviewer);
  console.log(count + " network scenarios passed");
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created)
    await control.query("DROP DATABASE " + database + " WITH (FORCE)");
  await control.end();
}
