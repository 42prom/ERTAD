import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_contribution_inbox_test_${randomBytes(8).toString("hex")}`,
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
    { enableDemoCollective } = await import("./web-demo-collective"),
    { enableDemoContribution } = await import("./web-demo-contribution");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");

  const app = createApp(
    {
      postgres: async () => {},
      redis: async () => {},
      storage: async () => {},
    },
    pino({ level: "silent" }),
    origin,
    createLocalAdminRouter(origin, () => access),
  );
  const sessions: {
    agent: ReturnType<typeof request.agent>;
    csrf: string;
    sessionId: string;
    sessionTokenHash: string;
  }[] = [];
  for (const a of access.accounts) {
    const agent = request.agent(app),
      login = await agent
        .post(base + "/demo/login")
        .set("Origin", origin)
        .send({ accountId: a.id })
        .expect(200);
    const row = (
      await owner.query(
        'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1',
        [a.id],
      )
    ).rows[0];
    sessions.push({ agent, csrf: login.body.csrfToken, ...row });
    await agent
      .post(base + "/demo/step-up")
      .set("Origin", origin)
      .set("X-Admin-Csrf", login.body.csrfToken)
      .send({})
      .expect(200);
  }
  const org = access.organizationId,
    unit = access.accounts[2].unitId;
  await owner.query("BEGIN");
  await enableDemoCollective(owner, access);
  await enableDemoContribution(owner, access);
  await owner.query("COMMIT");
  // An ordinary beneficiary retains unit access, without review/history grants.
  await owner.query(
    "UPDATE memberships m SET status='suspended' FROM positions p WHERE m.organization_id=p.organization_id AND m.position_id=p.id AND m.user_id=$1 AND p.name IN ('Collective finance demo','Contribution demo')",
    [access.accounts[3].memberId],
  );
  const { collectiveCommand } =
    await import("../backend/src/modules/governance/collective");
  const { inboxCommand } =
    await import("../backend/src/modules/communication/inbox");
  const { SecurityService } = await import("../backend/src/services/security");
  const c = (
    i: number,
    op: Parameters<typeof collectiveCommand>[1],
    input: object = {},
  ) => collectiveCommand(sessions[i], op, { organizationId: org, ...input });
  const inbox = (
    i: number,
    op: Parameters<typeof inboxCommand>[1],
    input: object = {},
  ) =>
    inboxCommand(
      sessions[i],
      op,
      op === "summary" ? input : { organizationId: org, ...input },
    );
  const list = (i: number, input: object = {}) =>
    inbox(i, "list", { source: "contribution", view: "all", ...input });
  const read = (i: number, id: string, version = 1) =>
    inbox(i, "read", { source: "contribution", id, version });
  const detail = (i: number, entryId: string) => c(i, "points", { entryId });
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
  const propose = (
    kind: string,
    parameters: object,
    unitId = unit,
    actor = 0,
  ) =>
    c(actor, "propose", {
      key: randomUUID(),
      unitId,
      kind,
      parameters,
      reason: "Synthetic private recognition reason",
      deadline: new Date(Date.now() + 3600000).toISOString(),
    });
  const vote = async (id: string, actor = 2, choice = "approve") =>
    c(actor, "vote", {
      key: randomUUID(),
      id,
      version: (await c(actor, "detail", { id })).version,
      choice,
      reason: "Synthetic independent approval",
    });
  const policy = await propose(
    "points_rule",
    {
      category: "manual",
      ruleVersion: 0,
      enabled: true,
      amount: 100,
      memberMonthCap: 1000,
      issuerMonthCap: 1000,
    },
    access.accounts[0].unitId,
    0,
  );
  await vote(policy.id, 1);
  const ruleId = (await c(0, "points")).rules.find(
    (r: any) => r.category === "manual",
  ).id;
  const award = () =>
    propose("points_award", {
      memberId: access.accounts[3].memberId,
      ruleId,
      amount: 7,
    });
  let first = "",
    correction = "";
  await check(
    "pending, rejected and withdrawn requests neither earn points nor notify the beneficiary",
    async () => {
      const rejected = await award();
      await vote(rejected.id, 2, "reject");
      const withdrawn = await award();
      await c(0, "withdraw", {
        key: randomUUID(),
        id: withdrawn.id,
        version: 1,
      });
      assert.equal((await list(3)).total, 0);
      assert.equal((await c(3, "points")).balance, "0");
    },
  );
  await check(
    "approved award reaches only its beneficiary without private proposal disclosure",
    async () => {
      const pending = await award();
      assert.equal((await list(3)).total, 0);
      await denied(vote(pending.id, 3));
      await vote(pending.id);
      const result = await list(3);
      assert.equal(result.total, 1);
      assert.equal(result.actionRequired, 0);
      const row = result.items[0];
      first = row.id;
      assert.equal(row.title, "contribution_record");
      assert.equal(row.status, "award");
      assert.equal(row.unread, true);
      assert.equal(row.deadline, null);
      assert.match(new Date(row.updatedAt).toISOString(), /T00:00:00\.000Z$/);
      const json = JSON.stringify(row);
      for (const secret of [
        pending.id,
        ruleId,
        access.accounts[3].memberId,
        "Synthetic private",
        "points",
        "sourceId",
        "issuerId",
      ])
        assert.equal(json.includes(secret), false);
      for (const i of [0, 1, 2, 4, 5]) {
        assert.equal((await list(i)).total, 0);
        await denied(detail(i, first));
        await denied(read(i, first));
      }
      const own = await detail(3, first);
      assert.equal(own.balance, "7");
      assert.equal(own.entries[0].points, 7);
      await denied(c(3, "detail", { id: pending.id }));
      await denied(
        c(3, "points", {
          entryId: first,
          memberId: access.accounts[2].memberId,
        }),
        400,
      );
    },
  );
  await check(
    "concurrent acknowledgements are idempotent and cannot alter points or acknowledge future versions",
    async () => {
      await Promise.all([read(3, first), read(3, first)]);
      assert.equal((await list(3, { view: "unread" })).total, 0);
      await denied(read(3, first, 2), 409);
      assert.equal((await c(3, "points")).balance, "7");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM contribution_inbox_reads WHERE entry_id=$1",
            [first],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    "approved correction creates a separate unread record without changing the original award",
    async () => {
      const p = await propose("points_reverse", { entryId: first });
      await vote(p.id);
      const rows = (await list(3)).items;
      correction = rows.find((r: any) => r.status === "reversal").id;
      assert.equal(rows.find((r: any) => r.id === first).unread, false);
      assert.equal(rows.find((r: any) => r.id === correction).unread, true);
      const own = await detail(3, correction);
      assert.equal(own.balance, "0");
      assert.equal(own.entries[0].points, -7);
      assert.equal(own.entries[0].reversesId, first);
      await read(3, first);
      assert.equal((await list(3, { view: "unread" })).total, 1);
    },
  );
  await check(
    "audit failure rolls back acknowledgement and award plus its projected notice",
    async () => {
      const pending = await award(),
        before = (await list(3)).total;
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic audit unavailable");
      };
      try {
        await assert.rejects(read(3, correction));
        await assert.rejects(
          c(2, "vote", {
            key: randomUUID(),
            id: pending.id,
            version: 1,
            choice: "approve",
            reason: "Synthetic approval",
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal((await list(3)).total, before);
      assert.equal(
        (await list(3)).items.find((r: any) => r.id === correction).unread,
        true,
      );
      assert.equal(
        (await c(0, "detail", { id: pending.id })).status,
        "pending",
      );
    },
  );
  await check(
    "current membership expiry during audit denies exact records and rolls back read state",
    async () => {
      const memberships = (
        await owner.query(
          "SELECT id,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, access.accounts[3].memberId],
        )
      ).rows;
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (client, ...args) => {
        await original.call(SecurityService, client, ...args);
        await client.query("SELECT pg_sleep(3)");
      };
      try {
        for (const op of [
          () => read(3, correction),
          () => detail(3, correction),
        ]) {
          await owner.query(
            "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=ANY($1::uuid[])",
            [memberships.map((m) => m.id)],
          );
          await denied(op());
        }
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        for (const m of memberships)
          await owner.query(
            "UPDATE memberships SET valid_until=$2 WHERE id=$1",
            [m.id, m.valid_until],
          );
      }
      assert.equal(
        (await list(3)).items.find((r: any) => r.id === correction).unread,
        true,
      );
    },
  );
  await check(
    "revoked membership removes notices and direct lookup while ledger remains intact",
    async () => {
      const ids = (
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE organization_id=$1 AND user_id=$2 AND status='active' RETURNING id",
          [org, access.accounts[3].memberId],
        )
      ).rows.map((r) => r.id);
      try {
        assert.deepEqual((await inbox(3, "summary")).contexts, []);
        await denied(list(3));
        await denied(detail(3, first));
        await denied(read(3, first));
      } finally {
        await owner.query(
          "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
          [ids],
        );
      }
      assert.equal((await detail(3, first)).entries[0].points, 7);
    },
  );
  await check(
    "HTTP and restricted SQL reject forged recipients, source access and CSRF bypasses",
    async () => {
      await request(app)
        .get(base + "/collective/points")
        .query({ organizationId: org, entryId: first })
        .expect(401);
      await sessions[4].agent
        .get(base + "/collective/points")
        .query({ organizationId: org, entryId: first })
        .expect(403);
      await sessions[3].agent
        .get(base + "/collective/points")
        .query({
          organizationId: org,
          entryId: first,
          recipientId: access.accounts[2].memberId,
        })
        .expect(400);
      const payload = {
        organizationId: org,
        source: "contribution",
        id: first,
        version: 1,
      };
      await sessions[3].agent
        .post(base + "/inbox/read")
        .send(payload)
        .expect(403);
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", "http://untrusted.invalid")
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(payload)
        .expect(403);
      const runtime = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await runtime.connect();
      try {
        for (const sql of [
          "SELECT * FROM ertad.contribution_inbox_reads",
          "SELECT * FROM ertad.contribution_entries",
          "SELECT ertad.contribution_view(NULL,NULL,'{}')",
          "SELECT ertad.inbox_entries(NULL,NULL)",
        ])
          await assert.rejects(
            runtime.query(sql),
            (e: any) => e.code === "42501",
          );
      } finally {
        await runtime.end();
      }
    },
  );
  await check(
    "expired proposals cannot award points and exact lookup reaches beyond the current history page",
    async () => {
      const p = await c(0, "propose", {
        key: randomUUID(),
        unitId: unit,
        kind: "points_award",
        parameters: {
          memberId: access.accounts[3].memberId,
          ruleId,
          amount: 7,
        },
        reason: "Synthetic short-lived recognition request",
        deadline: new Date(Date.now() + 2000).toISOString(),
      });
      await owner.query("SELECT pg_sleep(3)");
      const before = (await list(3)).total;
      await denied(vote(p.id), 409);
      assert.equal((await list(3)).total, before);
      // Real approved awards, never direct fabricated ledger inserts.
      for (let n = 0; n < 25; n++) {
        const a = await award();
        await vote(a.id);
      }
      const page = await c(3, "points", { page: 2 });
      assert.ok(page.entries.length > 0);
      const outside = page.entries[0].id;
      const exact = await detail(3, outside);
      assert.equal(exact.total, 1);
      assert.equal(exact.entries[0].id, outside);
      assert.equal(exact.balance, (await c(3, "points")).balance);
    },
  );
  console.log(`Contribution inbox: ${checks} database scenarios passed`);
  if (process.argv.includes("--browser")) {
    const { verifyContributionBrowser } =
      await import("./contribution-browser");
    await verifyContributionBrowser(app, access);
  }
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
