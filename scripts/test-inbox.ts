import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_inbox_test_${randomBytes(8).toString("hex")}`,
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
    { enableDemoWork } = await import("./web-demo-work");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { workCommand } = await import("../backend/src/modules/work/tasks");
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
    a = access.accounts[2].unitId,
    b = access.accounts[4].unitId;
  const command = (
    i: number,
    op: Parameters<typeof workCommand>[1],
    input: object = {},
  ) =>
    workCommand(
      sessions[i],
      op,
      op === "contexts" ? input : { organizationId: org, ...input },
    );
  const { inboxCommand } =
    await import("../backend/src/modules/communication/inbox");
  const { unitCommand } =
    await import("../backend/src/modules/organization/units");
  const { collectiveCommand } =
    await import("../backend/src/modules/governance/collective");
  const { reviewCommand } =
    await import("../backend/src/modules/governance/reviews");
  const { SecurityService } = await import("../backend/src/services/security");
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
  const units = (
    i: number,
    op: Parameters<typeof unitCommand>[1],
    input: object = {},
  ) => unitCommand(sessions[i], op, { organizationId: org, ...input });
  const collective = (
    i: number,
    op: Parameters<typeof collectiveCommand>[1],
    input: object = {},
  ) => collectiveCommand(sessions[i], op, { organizationId: org, ...input });
  const reviews = (
    i: number,
    op: Parameters<typeof reviewCommand>[1],
    input: object = {},
  ) => reviewCommand(sessions[i], op, { organizationId: org, ...input });
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
  await owner.query("BEGIN");
  await enableDemoWork(owner, access);
  await (
    await import("./web-demo-hierarchy")
  ).enableDemoHierarchy(owner, access);
  await (
    await import("./web-demo-work-needs")
  ).enableDemoWorkNeeds(owner, access);
  await (
    await import("./web-demo-collective")
  ).enableDemoCollective(owner, access);
  await (
    await import("./web-demo-contribution")
  ).enableDemoContribution(owner, access);
  await owner.query("COMMIT");
  const deadline = () => new Date(Date.now() + 3600000).toISOString();
  const group = await units(2, "propose", {
    key: randomUUID(),
    parentId: a,
    name: "Synthetic inbox group",
    reason: "Synthetic group creation request",
    expiresAt: deadline(),
  });
  const task = await command(2, "create", {
    key: randomUUID(),
    unitId: a,
    capacity: 3,
    title: "Synthetic inbox task",
    description: "Synthetic task with independent review",
    roleLabel: "Volunteer",
    priority: "normal",
    deadline: deadline(),
  });
  const proposal = await collective(2, "propose", {
    key: randomUUID(),
    unitId: a,
    kind: "directive",
    parameters: {
      title: "Synthetic directive",
      body: "Synthetic content excluded from inbox previews.",
    },
    reason: "Synthetic private reason",
    deadline: deadline(),
  });
  const all = (i: number, input: object = {}) =>
    inbox(i, "list", { view: "all", ...input });
  const find = async (i: number, source: string, id: string) =>
    (await all(i, { source })).items.find((r: any) => r.id === id);
  const ack = (i: number, item: any) =>
    inbox(i, "read", {
      source: item.source,
      id: item.id,
      version: item.version,
    });
  const detail = (i: number, id: string) => command(i, "detail", { id });
  const act = async (
    i: number,
    op: Parameters<typeof workCommand>[1],
    extra: object = {},
  ) =>
    command(i, op, {
      id: task.id,
      key: randomUUID(),
      version: (await detail(i, task.id)).version,
      ...extra,
    });
  await check(
    "four queues unify, summaries count visible records, sibling scope denied",
    async () => {
      const list = await all(3),
        summary = await inbox(3, "summary");
      assert.deepEqual(
        new Set(list.items.map((r: any) => r.source)),
        new Set(["membership", "unit", "work", "collective"]),
      );
      assert.equal(
        summary.unread,
        list.items.filter((r: any) => r.unread).length,
      );
      assert.equal(
        summary.actionRequired,
        list.items.filter((r: any) => r.action).length,
      );
      assert.equal(
        (await all(4)).items.some((r: any) =>
          [task.id, group.id, proposal.id].includes(r.id),
        ),
        false,
      );
      await denied(
        inbox(4, "read", { source: "work", id: task.id, version: 1 }),
      );
      await denied(all(3, { organizationId: randomUUID() }));
      assert.ok(!JSON.stringify(list).includes("Synthetic private reason"));
      assert.ok(!JSON.stringify(list).includes("content excluded"));
      await assert.rejects(
        db.query("SELECT * FROM ertad.unit_inbox_reads"),
        (e: any) => e.code === "42501",
      );
      await assert.rejects(
        db.query("SELECT * FROM ertad.inbox_entries($1,$2)", [
          access.accounts[3].memberId,
          org,
        ]),
        (e: any) => e.code === "42501",
      );
    },
  );
  await check(
    "read acknowledgement preserves pending action; a later decision is unread again",
    async () => {
      const item = await find(3, "unit", group.id);
      assert.equal(item.action, "review");
      await ack(3, item);
      await ack(3, item);
      assert.equal((await find(3, "unit", group.id)).unread, false);
      assert.equal(
        (await inbox(3, "list", { view: "action", source: "unit" })).total,
        1,
      );
      assert.equal((await find(2, "unit", group.id)).action, "");
      await units(3, "decide", {
        id: group.id,
        key: randomUUID(),
        decision: "approved",
        reason: "Synthetic independent approval",
      });
      assert.equal((await find(3, "unit", group.id)).unread, true);
      await ack(3, item);
      assert.equal((await find(3, "unit", group.id)).unread, true);
      await ack(3, await find(3, "unit", group.id));
      assert.equal((await find(3, "unit", group.id)).unread, false);
      await denied(
        inbox(3, "read", { source: "unit", id: group.id, version: 3 }),
        409,
      );
      assert.equal(
        (await units(3, "detail", { id: group.id })).status,
        "approved",
      );
    },
  );
  await check(
    "work acknowledgement is exact-version and shares canonical domain read state",
    async () => {
      const item = await find(3, "work", task.id);
      assert.ok(item.unread);
      await ack(3, item);
      assert.equal((await find(3, "work", task.id)).unread, false);
      await act(2, "criteria", {
        criteria: [
          {
            id: randomUUID(),
            title: "Independent acceptance criterion",
            weight: 1,
          },
        ],
      });
      assert.equal((await find(3, "work", task.id)).unread, true);
      await ack(3, item);
      assert.equal((await find(3, "work", task.id)).unread, true);
      const current = await find(3, "work", task.id);
      await command(3, "ack", { id: task.id, version: current.version });
      assert.equal((await find(3, "work", task.id)).unread, false);
      await denied(
        inbox(3, "read", {
          source: "work",
          id: task.id,
          version: current.version + 1,
        }),
        409,
      );
    },
  );
  await check(
    "collective action excludes proposer and completed reviews; read state shared",
    async () => {
      assert.equal((await find(2, "collective", proposal.id)).action, "");
      const item = await find(3, "collective", proposal.id);
      assert.equal(item.action, "review");
      await ack(3, item);
      assert.equal((await find(3, "collective", proposal.id)).unread, false);
      await collective(3, "vote", {
        id: proposal.id,
        key: randomUUID(),
        version: item.version,
        choice: "approve",
        reason: "Independent synthetic approval",
      });
      assert.equal((await find(3, "collective", proposal.id)).action, "");
      await ack(3, item);
      assert.equal((await find(3, "collective", proposal.id)).unread, true);
      await collective(3, "ack", {
        id: proposal.id,
        version: (await find(3, "collective", proposal.id)).version,
      });
      assert.equal((await find(3, "collective", proposal.id)).unread, false);
    },
  );
  await check(
    "membership notifications share read state without changing appointment",
    async () => {
      const item = (await all(3, { source: "membership" })).items[0];
      assert.equal(item.action, "review");
      await ack(3, item);
      assert.equal((await find(3, "membership", item.id)).action, "review");
      await reviews(3, "decide", {
        id: item.id,
        key: randomUUID(),
        decision: "approved",
        reason: "Independent synthetic appointment",
      });
      const target = await find(2, "membership", item.id);
      assert.equal(target.unread, true);
      await reviews(2, "read", { id: item.id });
      assert.equal((await find(2, "membership", item.id)).unread, false);
      assert.equal(
        (await reviews(2, "detail", { id: item.id })).status,
        "approved",
      );
    },
  );
  await check(
    "audit failure rolls back acknowledgement and expiry is rechecked after audit",
    async () => {
      await act(2, "criteria", {
        criteria: [
          {
            id: randomUUID(),
            title: "Second independent criterion",
            weight: 1,
          },
        ],
      });
      const item = await find(3, "work", task.id),
        audit = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic audit failure");
      };
      try {
        await assert.rejects(ack(3, item), /Synthetic audit failure/);
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal((await find(3, "work", task.id)).unread, true);
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        await audit.call(SecurityService, client, event, data);
        await client.query(
          "UPDATE ertad.admin_sessions SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [sessions[3].sessionId],
        );
      };
      try {
        await denied(ack(3, item));
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal((await find(3, "work", task.id)).unread, true);
    },
  );
  await check(
    "HTTP session, CSRF, origin and strict filter/version validation",
    async () => {
      await request(app)
        .get(base + "/inbox/summary")
        .expect(401);
      await sessions[3].agent
        .get(base + "/inbox")
        .query({ organizationId: org, source: "all", view: "all" })
        .expect(200);
      await sessions[3].agent
        .get(base + "/inbox")
        .query({ organizationId: org, source: "unknown" })
        .expect(400);
      const item = await find(3, "work", task.id),
        input = {
          organizationId: org,
          source: item.source,
          id: item.id,
          version: item.version,
        };
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", origin)
        .send(input)
        .expect(403);
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", "https://invalid.example")
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(input)
        .expect(403);
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send({ ...input, recipientId: access.accounts[2].memberId })
        .expect(400);
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(input)
        .expect(200);
    },
  );
  await check(
    "current grants are rechecked during audit; hidden finance leaves no count or preview",
    async () => {
      const funding = await collective(2, "propose", {
        key: randomUUID(),
        unitId: a,
        workId: task.id,
        kind: "funding_target",
        parameters: {
          currency: "GEL",
          amount: "10000",
          targetVersion: 0,
          purpose: "Synthetic funding purpose",
        },
        reason: "Private financial review",
        deadline: deadline(),
      });
      assert.ok(await find(3, "collective", funding.id));
      const authority = (
        await owner.query(
          "SELECT m.id,m.valid_until FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.user_id=$1 AND p.name='Collective finance demo'",
          [access.accounts[3].memberId],
        )
      ).rows[0];
      await owner.query(
        "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [authority.id],
      );
      const audit = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        await audit.call(SecurityService, client, event, data);
        await client.query("SELECT pg_sleep(3)");
      };
      try {
        assert.equal((await all(3, { source: "collective" })).total, 0);
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal((await all(3, { source: "collective" })).unread, 0);
      await denied(
        inbox(3, "read", { source: "collective", id: funding.id, version: 1 }),
      );
      await owner.query("UPDATE memberships SET valid_until=$2 WHERE id=$1", [
        authority.id,
        authority.valid_until,
      ]);
    },
  );
  await check(
    "verification actions exclude self-review and retain independently submitted criteria",
    async () => {
      const criterion = (await detail(2, task.id)).criteria[0].id;
      await act(2, "criterion_submit", {
        criterionId: criterion,
        note: "Synthetic completion evidence",
      });
      assert.equal((await find(2, "work", task.id)).action, "");
      assert.equal((await find(3, "work", task.id)).action, "verify");
      await ack(3, await find(3, "work", task.id));
      assert.equal((await find(3, "work", task.id)).action, "verify");
    },
  );
  await check(
    "hierarchy move hides stale work and collective records immediately",
    async () => {
      const saved = (
        await owner.query(
          "SELECT parent_id FROM units WHERE organization_id=$1 AND id=$2",
          [org, a],
        )
      ).rows[0];
      await owner.query(
        "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
        [org, a, b],
      );
      try {
        assert.equal(await find(3, "work", task.id), undefined);
        assert.equal(await find(3, "collective", proposal.id), undefined);
        await denied(
          inbox(3, "read", { source: "work", id: task.id, version: 1 }),
        );
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, a, saved.parent_id],
        );
      }
    },
  );
  await check(
    "expired requests remain history without an actionable approval",
    async () => {
      // Historical fixture is inserted once; immutable production reviews stay immutable.
      const expired = (
        await owner.query(
          `INSERT INTO unit_reviews(organization_id,parent_id,parent_path,name,requester_id,reason,request_key,created_at,expires_at)
        SELECT organization_id,parent_id,parent_path,'Synthetic expired request',requester_id,'Synthetic time boundary',gen_random_uuid(),now()-interval '2 hours',now()-interval '1 hour'
        FROM unit_reviews WHERE organization_id=$1 AND id=$2 RETURNING id`,
          [org, group.id],
        )
      ).rows[0];
      const item = await find(3, "unit", expired.id);
      assert.equal(item.status, "expired");
      assert.equal(item.action, "");
      assert.equal(
        (await inbox(3, "list", { view: "action", source: "unit" })).items.some(
          (r: any) => r.id === expired.id,
        ),
        false,
      );
    },
  );
  await check(
    "pagination is bounded and deterministic across equal timestamps and category filters",
    async () => {
      await owner.query(
        `INSERT INTO unit_reviews(organization_id,parent_id,parent_path,name,requester_id,reason,request_key,created_at,expires_at)
        SELECT r.organization_id,r.parent_id,r.parent_path,'Synthetic paginated group '||n,r.requester_id,'Synthetic pagination boundary',gen_random_uuid(),now(),now()+interval '1 hour'
        FROM unit_reviews r CROSS JOIN generate_series(1,26) n WHERE r.organization_id=$1 AND r.id=$2`,
        [org, group.id],
      );
      const first = await all(3, { source: "unit", page: 1 }),
        second = await all(3, { source: "unit", page: 2 });
      assert.equal(first.items.length, 25);
      assert.equal(first.pageSize, 25);
      assert.ok(second.items.length > 0);
      assert.equal(
        new Set([...first.items, ...second.items].map((r: any) => r.id)).size,
        first.total,
      );
      assert.deepEqual(
        (await all(3, { source: "unit", page: 1 })).items,
        first.items,
      );
      assert.ok(first.items.every((r: any) => r.source === "unit"));
      await denied(all(3, { page: 1001 }), 400);
    },
  );
  await check(
    "scoped reports, shortfall filters, and event inbox notifications respect unit isolation and acknowledge cleanly",
    async () => {
      const workReportA = await command(2, "report", { view: "all" });
      assert(workReportA.items.some((r: any) => r.id === task.id));
      const workReportB = await command(4, "report", { view: "all" });
      assert(!workReportB.items.some((r: any) => r.id === task.id));

      const shortfallsList = await command(2, "list", { view: "shortfalls" });
      assert(Array.isArray(shortfallsList.items));

      const ev = await command(2, "event_create", {
        key: randomUUID(),
        unitId: a,
        title: "Upcoming reminder event",
        description: "Starts within 48h",
        location: "Office",
        startsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        endsAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
        contributionRuleId: null,
      });
      const eventInboxA = await all(2, { source: "event" });
      const evRow = eventInboxA.items.find((r: any) => r.id === ev.id);
      assert(evRow);
      assert.equal(evRow.unread, true);
      assert.equal(evRow.action, "event_follow_up");
      const eventInboxB = await all(4, { source: "event" });
      assert(!eventInboxB.items.some((r: any) => r.id === ev.id));

      await inbox(2, "read", {
        source: "event",
        id: ev.id,
        version: evRow.version,
      });
      const afterAck = (await all(2, { source: "event" })).items.find(
        (r: any) => r.id === ev.id,
      );
      assert.equal(afterAck.unread, false);
    },
  );
  console.log(`Unified inbox: ${checks} database scenarios passed`);
  if (process.argv.includes("--browser"))
    await (
      await import("./inbox-browser")
    ).verifyInboxBrowser(app, access, {
      taskId: task.id,
      groupId: group.id,
      proposalId: proposal.id,
    });
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
