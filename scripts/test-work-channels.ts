import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_work_channels_test_${randomBytes(8).toString("hex")}`,
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
    { enableDemoChannels } = await import("./web-demo-channels");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { channelCommand } =
    await import("../backend/src/modules/communication/channels");
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
    op: Parameters<typeof channelCommand>[1],
    input: object = {},
  ) =>
    channelCommand(
      sessions[i],
      op,
      op === "contexts" ? input : { organizationId: org, ...input },
    );
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
  const write = (
    i: number,
    op: Parameters<typeof channelCommand>[1],
    input: object = {},
  ) => command(i, op, { key: randomUUID(), ...input });
  const { workCommand } = await import("../backend/src/modules/work/tasks");
  const { enableDemoWork } = await import("./web-demo-work");
  const work = (
    i: number,
    op: Parameters<typeof workCommand>[1],
    input: object = {},
  ) => workCommand(sessions[i], op, { organizationId: org, ...input });
  const fresh = (unitId = a, title = "Synthetic task conversation") => ({
    unitId,
    title,
    description: "Synthetic collaboration",
    roleLabel: "Volunteer",
    capacity: 3,
    priority: "normal",
    deadline: new Date(Date.now() + 3600000).toISOString(),
    key: randomUUID(),
  });
  const act = async (
    i: number,
    op: Parameters<typeof workCommand>[1],
    id: string,
    extra: object = {},
  ) =>
    work(i, op, {
      id,
      key: randomUUID(),
      version: (await work(i, "detail", { id })).version,
      ...extra,
    });
  await owner.query("BEGIN");
  await enableDemoWork(owner, access);
  await owner.query("COMMIT");
  const task = await work(2, "create", fresh()),
    workId = task.id;
  await check(
    "task authority alone does not grant conversation access",
    async () => {
      await denied(command(2, "work", { workId }));
      await denied(write(2, "work-create", { workId }));
    },
  );
  await owner.query("BEGIN");
  await enableDemoChannels(owner, access);
  await owner.query("COMMIT");
  let id = "";
  await check(
    "opening is read-only; concurrent creation and different manager retries return one channel",
    async () => {
      assert.deepEqual(await command(2, "work", { workId }), {
        id: null,
        canCreate: true,
      });
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM channels WHERE work_id=$1",
            [workId],
          )
        ).rows[0].n,
        0,
      );
      const input = { workId, key: randomUUID() };
      const replies = await Promise.all([
        command(2, "work-create", input),
        command(2, "work-create", input),
        write(3, "work-create", { workId }),
      ]);
      id = replies[0].id;
      assert.ok(replies.every((r) => r.id === id));
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM channels WHERE work_id=$1",
            [workId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal((await command(0, "work", { workId })).id, id);
      assert.equal((await command(2, "thread", { id })).channel.workId, workId);
      await denied(command(4, "work", { workId }));
      await denied(command(4, "thread", { id }));
      await denied(
        command(3, "work", { workId, organizationId: randomUUID() }),
      );
      await assert.rejects(
        db.query("SELECT * FROM ertad.channels"),
        (e: any) => e.code === "42501",
      );
      await assert.rejects(
        owner.query("UPDATE channels SET work_id=NULL WHERE id=$1", [id]),
        (e: any) => e.code === "23514",
      );
    },
  );
  let first: any, reply: any;
  await check(
    "the existing text, reply, read, mute and moderation flows work in a task channel",
    async () => {
      first = await write(2, "post", {
        id,
        body: "SYNTHETIC_TASK_PRIVATE_MESSAGE",
      });
      reply = await write(3, "post", {
        id,
        body: "Synthetic task reply",
        replyId: first.messageId,
      });
      const detail = await command(3, "thread", { id });
      assert.equal(detail.items[1].replySeq, 1);
      await write(3, "read", { id, seq: 2 });
      assert.equal((await command(3, "thread", { id })).channel.unread, 0);
      await write(3, "mute", { id, muted: true });
      assert.equal((await command(3, "thread", { id })).channel.muted, true);
      await write(3, "report", {
        id,
        messageId: first.messageId,
        category: "privacy",
      });
      assert.equal((await command(3, "reports", { id })).total, 0);
      const report = (await command(0, "reports", { id })).items[0];
      await write(0, "resolve", { id, reportId: report.id, outcome: "remove" });
      assert.equal((await command(3, "thread", { id })).items[0].body, "");
    },
  );
  await check(
    "a broad channel grant does not admit task observers or applicants; current assigned members can converse",
    async () => {
      const member = access.accounts[3].memberId;
      // Find the existing Work permission membership by grant, without changing shared bundles.
      const workGrants = (
        await owner.query(
          "SELECT DISTINCT m.id FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id JOIN permission_grants g ON g.organization_id=p.organization_id AND g.bundle_id=p.bundle_id AND g.bundle_version=p.bundle_version WHERE m.user_id=$1 AND g.permission='workitem.create'",
          [member],
        )
      ).rows.map((r) => r.id);
      assert.ok(workGrants.length);
      const bundle = randomUUID(),
        position = randomUUID();
      await owner.query("BEGIN");
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
        [workGrants],
      );
      await owner.query(
        "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
        [org, bundle],
      );
      for (const permission of ["workitem.read", "workitem.participate"])
        await owner.query(
          "INSERT INTO permission_grants VALUES($1,$2,1,$3,'subtree')",
          [org, bundle, permission],
        );
      await owner.query(
        "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic conversation participant',$4,1)",
        [org, position, a, bundle],
      );
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
        [org, member, a, position],
      );
      await owner.query("COMMIT");
      try {
        await denied(command(3, "thread", { id }));
        assert.equal(
          (await command(3, "list")).items.some((c: any) => c.id === id),
          false,
        );
        await act(3, "apply", workId);
        await denied(command(3, "work", { workId }));
        await act(2, "assign", workId, { memberId: member });
        assert.equal((await command(3, "work", { workId })).id, id);
        await write(3, "post", { id, body: "Assigned member contribution" });
        assert.equal(
          (await command(3, "thread", { id })).channel.canManage,
          false,
        );
        await denied(write(3, "archive", { id, version: 1, archived: true }));
        await act(3, "withdraw", workId);
        await denied(command(3, "thread", { id }));
        await denied(write(3, "read", { id, seq: 1 }));
      } finally {
        await owner.query(
          "UPDATE memberships SET status='ended' WHERE organization_id=$1 AND position_id=$2",
          [org, position],
        );
        await owner.query(
          "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
          [workGrants],
        );
      }
    },
  );
  await check(
    "task completion and cancellation are read-only even when channel archive is false",
    async () => {
      for (const op of ["complete", "cancel"] as const) {
        const w = await work(
          2,
          "create",
          fresh(a, "Synthetic " + op + " conversation"),
        );
        const channel = await write(2, "work-create", { workId: w.id });
        await write(2, "post", {
          id: channel.id,
          body: "Synthetic retained history",
        });
        if (op === "complete") {
          await act(2, "apply", w.id);
          await act(3, "assign", w.id, {
            memberId: access.accounts[2].memberId,
          });
          await act(2, "start", w.id);
          await act(2, "submit", w.id, { note: "Synthetic completed work" });
          await act(0, "verify", w.id, {
            memberId: access.accounts[2].memberId,
          });
        }
        await act(2, op, w.id, { note: "Synthetic lifecycle check" });
        const result = await command(2, "thread", { id: channel.id });
        assert.equal(result.channel.archived, true);
        assert.equal(result.channel.canPost, false);
        assert.equal(result.channel.canManage, false);
        assert.equal(result.items.length, 1);
        await denied(
          write(2, "post", { id: channel.id, body: "Forbidden after closure" }),
        );
        await denied(
          write(2, "archive", { id: channel.id, version: 1, archived: false }),
        );
        assert.ok(
          (await command(2, "list", { view: "archived" })).items.some(
            (c: any) => c.id === channel.id,
          ),
        );
      }
    },
  );
  await check(
    "child tasks have independent channels and sibling scopes cannot read parent conversations",
    async () => {
      const group = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 LIMIT 1",
          [org, a],
        )
      ).rows[0].id;
      const child = await act(2, "delegate", workId, {
        ...fresh(group, "Synthetic child conversation"),
        capacity: 1,
        deadline: new Date(
          (await work(2, "detail", { id: workId })).deadline,
        ).toISOString(),
      });
      await denied(write(2, "work-create", { workId: child.id }));
      await act(2, "accept", child.id, { capacity: 1 });
      const childChannel = await write(2, "work-create", { workId: child.id });
      assert.notEqual(childChannel.id, id);
      await denied(
        write(2, "post", {
          id: childChannel.id,
          body: "Cross-task reply",
          replyId: reply.messageId,
        }),
        409,
      );
      await denied(command(4, "thread", { id: childChannel.id }));
    },
  );
  const { SecurityService } = await import("../backend/src/services/security");
  await check(
    "audit failure rolls back creation; actual grant expiry during audit hides task messages",
    async () => {
      const w = await work(
          2,
          "create",
          fresh(a, "Synthetic rollback conversation"),
        ),
        audit = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic audit failure");
      };
      try {
        await assert.rejects(
          write(2, "work-create", { workId: w.id }),
          /Synthetic audit failure/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal((await command(2, "work", { workId: w.id })).id, null);
      const authority = (
        await owner.query(
          "SELECT m.id,m.valid_until FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.user_id=$1 AND p.name='Channel operations demo'",
          [access.accounts[2].memberId],
        )
      ).rows[0];
      const before = (await command(3, "thread", { id })).channel.lastSeq;
      await owner.query(
        "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [authority.id],
      );
      SecurityService.logAuditEventInTransaction = async (client, ...args) => {
        await audit.call(SecurityService, client, ...args);
        await client.query("SELECT pg_sleep(3)");
      };
      try {
        await denied(write(2, "post", { id, body: "Expired authority" }));
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
        await owner.query("UPDATE memberships SET valid_until=$2 WHERE id=$1", [
          authority.id,
          authority.valid_until,
        ]);
      }
      assert.equal(
        (await command(3, "thread", { id })).channel.lastSeq,
        before,
      );
    },
  );
  await check(
    "hierarchy movement invalidates both task and conversation ancestry",
    async () => {
      const parent = (
        await owner.query(
          "SELECT parent_id FROM units WHERE organization_id=$1 AND id=$2",
          [org, a],
        )
      ).rows[0].parent_id;
      await owner.query(
        "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
        [org, a, b],
      );
      try {
        await denied(command(0, "work", { workId }));
        await denied(command(2, "thread", { id }));
        assert.equal((await command(2, "list")).total, 0);
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, a, parent],
        );
      }
    },
  );
  await check(
    "HTTP authority, CSRF, Origin and immutable task association reject forged inputs",
    async () => {
      await request(app)
        .get(base + "/channels/work")
        .query({ organizationId: org, workId })
        .expect(401);
      await sessions[3].agent
        .get(base + "/channels/work")
        .query({ organizationId: org, workId })
        .expect(200);
      const body = { organizationId: org, workId, key: randomUUID() };
      await sessions[3].agent
        .post(base + "/channels/work-create")
        .set("Origin", origin)
        .send(body)
        .expect(403);
      await sessions[3].agent
        .post(base + "/channels/work-create")
        .set("Origin", "https://invalid.example")
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(body)
        .expect(403);
      await sessions[3].agent
        .post(base + "/channels/work-create")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send({ ...body, unitId: b })
        .expect(400);
      await sessions[3].agent
        .post(base + "/channels/work-create")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(body)
        .expect(200);
    },
  );
  console.log(`Task channels: ${checks} database scenarios passed`);
  if (process.argv.includes("--browser"))
    await (
      await import("./work-channels-browser")
    ).verifyWorkChannelsBrowser(app, access, workId);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
