import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_moderation_inbox_test_${randomBytes(8).toString("hex")}`,
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
  await owner.query("BEGIN");
  await enableDemoChannels(owner, access);
  await owner.query("COMMIT");

  const { inboxCommand } =
    await import("../backend/src/modules/communication/inbox");
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
  const list = (i: number, extra: object = {}) =>
    inbox(i, "list", { source: "moderation", view: "all", ...extra });
  const read = (i: number, id: string, version: number) =>
    inbox(i, "read", { source: "moderation", id, version });
  const detail = (i: number, restrictionId: string) =>
    command(i, "restriction", { restrictionId });
  const make = async (seconds = 3600, report = false) => {
    const id = (
      await write(2, "create", {
        unitId: a,
        title: "Synthetic private notice channel",
      })
    ).id;
    const messageId = (
      await write(3, "post", { id, body: "Synthetic private message body" })
    ).messageId;
    if (report) await write(0, "report", { id, messageId, category: "other" });
    const restrictionId = (
      await write(2, "restrict", {
        id,
        messageId,
        reason: "Synthetic private restriction reason",
        expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
      })
    ).restrictionId;
    return { id, restrictionId };
  };
  const appeal = (r: { id: string; restrictionId: string }) =>
    write(3, "appeal", {
      ...r,
      version: 1,
      reason: "Synthetic private appeal reason",
    });
  const review = (r: { id: string; restrictionId: string }, outcome = "lift") =>
    write(1, "review-appeal", {
      ...r,
      version: 2,
      outcome,
      reason: "Synthetic private review reason",
    });
  const first = await make(3600, true);
  await check(
    "recipient-specific notices have minimal previews and current exact-record access",
    async () => {
      const mine = await list(3),
        issuer = await list(2);
      assert.equal(mine.total, 1);
      assert.equal(issuer.total, 1);
      assert.equal(mine.items[0].id, first.restrictionId);
      assert.equal(mine.items[0].title, "channel_restriction");
      assert.equal(mine.items[0].version, 1);
      assert.equal(mine.items[0].unread, true);
      assert.equal(mine.items[0].action, "");
      for (const secret of [
        "Synthetic",
        first.id,
        access.accounts[3].memberId,
        "reason",
        "appeal",
        "messageId",
      ])
        assert.ok(!JSON.stringify(mine).includes(secret));
      for (const i of [0, 1, 4, 5]) assert.equal((await list(i)).total, 0);
      assert.equal((await detail(3, first.restrictionId)).mine, true);
      await denied(detail(4, first.restrictionId));
      await denied(detail(3, randomUUID()));
      await denied(
        command(3, "restriction", {
          organizationId: randomUUID(),
          restrictionId: first.restrictionId,
        }),
      );
      assert.ok((await inbox(3, "summary")).unread >= mine.unread);
    },
  );
  await check(
    "reading is independent of appeal/review and cannot consume later lifecycle notices",
    async () => {
      await Promise.all([
        read(3, first.restrictionId, 1),
        read(3, first.restrictionId, 1),
      ]);
      assert.equal((await list(3)).items[0].unread, false);
      assert.equal((await detail(3, first.restrictionId)).version, 1);
      await appeal(first);
      await read(3, first.restrictionId, 1);
      assert.equal((await list(3)).items[0].unread, true);
      assert.equal(
        (await list(1, { view: "action" })).items[0].action,
        "review_appeal",
      );
      assert.equal((await list(1)).items[0].version, 3);
      for (const i of [0, 2, 3, 4])
        assert.equal((await list(i, { view: "action" })).total, 0);
      await read(1, first.restrictionId, 3);
      assert.equal((await list(1, { view: "action" })).total, 1);
      await denied(read(1, first.restrictionId, 6), 409);
      assert.equal((await detail(1, first.restrictionId)).version, 2);
      await review(first);
      await read(1, first.restrictionId, 3);
      const notice = (await list(1)).items[0];
      assert.equal(notice.version, 5);
      assert.equal(notice.unread, true);
      assert.equal(notice.status, "lifted");
      assert.equal((await list(1, { view: "action" })).total, 0);
      assert.equal((await list(3)).items[0].status, "lifted");
      assert.equal((await list(0)).total, 0);
    },
  );
  await check(
    "actual expiry advances notice version and late appeals/upholds remain monotonic",
    async () => {
      const r = await make(8);
      await read(3, r.restrictionId, 1);
      await owner.query("SELECT pg_sleep(8)");
      const current = () =>
        list(3).then((p) => p.items.find((x: any) => x.id === r.restrictionId));
      assert.equal((await current()).version, 2);
      assert.equal((await current()).status, "expired");
      await read(3, r.restrictionId, 2);
      await appeal(r);
      assert.equal((await current()).version, 4);
      assert.equal((await current()).unread, true);
      await read(3, r.restrictionId, 4);
      await review(r, "uphold");
      assert.equal((await current()).version, 6);
      assert.equal((await current()).status, "expired");
      assert.equal((await current()).unread, true);
      assert.equal((await detail(3, r.restrictionId)).active, false);
      await read(3, r.restrictionId, 6);
      await read(3, r.restrictionId, 1);
      assert.equal((await current()).unread, false);
    },
  );
  const pending = await make();
  await appeal(pending);
  await check(
    "audit failure rolls back read state and exact detail remains read-only",
    async () => {
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic notice audit failure");
      };
      try {
        await assert.rejects(
          read(1, pending.restrictionId, 3),
          /Synthetic notice audit failure/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM moderation_inbox_reads WHERE restriction_id=$1",
            [pending.restrictionId],
          )
        ).rows[0].n,
        0,
      );
      await detail(1, pending.restrictionId);
      assert.equal(
        (await list(1)).items.find((x: any) => x.id === pending.restrictionId)
          .unread,
        true,
      );
    },
  );
  await check(
    "expiry during audit rejects acknowledgement and exact-detail disclosure",
    async () => {
      const grant = (
        await owner.query(
          "SELECT m.id,m.valid_until FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.user_id=$1 AND p.name='Channel operations demo'",
          [access.accounts[1].memberId],
        )
      ).rows[0];
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (client, ...args) => {
        await original.call(SecurityService, client, ...args);
        await client.query("SELECT pg_sleep(3)");
      };
      try {
        for (const operation of [
          () => read(1, pending.restrictionId, 3),
          () => detail(1, pending.restrictionId),
        ]) {
          await owner.query(
            "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",
            [grant.id],
          );
          await denied(operation());
        }
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query("UPDATE memberships SET valid_until=$2 WHERE id=$1", [
          grant.id,
          grant.valid_until,
        ]);
      }
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM moderation_inbox_reads WHERE restriction_id=$1",
            [pending.restrictionId],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await check(
    "hierarchy movement removes rows, counters and stale acknowledgement access",
    async () => {
      const parent = (
        await owner.query(
          "SELECT parent_id FROM units WHERE id=$1 AND organization_id=$2",
          [a, org],
        )
      ).rows[0].parent_id;
      await owner.query(
        "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
        [org, a, b],
      );
      try {
        for (const i of [1, 2, 3, 4]) {
          const result = await list(i);
          assert.equal(result.total, 0);
          assert.equal(result.unread, 0);
          assert.equal(result.actionRequired, 0);
          await denied(read(i, pending.restrictionId, 3));
          await denied(detail(i, pending.restrictionId));
        }
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, a, parent],
        );
      }
    },
  );
  await check(
    "HTTP and restricted database role reject bypasses and forged recipients",
    async () => {
      await request(app)
        .get(base + "/channels/restriction")
        .query({ organizationId: org, restrictionId: first.restrictionId })
        .expect(401);
      await sessions[4].agent
        .get(base + "/channels/restriction")
        .query({ organizationId: org, restrictionId: first.restrictionId })
        .expect(403);
      await sessions[3].agent
        .get(base + "/channels/restriction")
        .query({
          organizationId: org,
          restrictionId: first.restrictionId,
          actorId: access.accounts[2].memberId,
        })
        .expect(400);
      const body = {
        organizationId: org,
        source: "moderation",
        id: first.restrictionId,
        version: 5,
      };
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", "https://invalid.example")
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(body)
        .expect(403);
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", origin)
        .send(body)
        .expect(403);
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send({ ...body, recipientId: access.accounts[2].memberId })
        .expect(400);
      const runtime = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await runtime.connect();
      try {
        for (const sql of [
          "SELECT * FROM ertad.moderation_inbox_reads",
          "SELECT * FROM ertad.inbox_entries(null,null)",
          "SELECT ertad.channel_moderation_command(null,null,null,null,null,null)",
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
    "read/post-only members see only their own records and cannot moderate",
    async () => {
      const member = access.accounts[3].memberId;
      const old = (
        await owner.query(
          "SELECT id FROM memberships WHERE user_id=$1 AND status='active'",
          [member],
        )
      ).rows.map((r) => r.id);
      const bundle = randomUUID(),
        position = randomUUID();
      await owner.query("BEGIN");
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
        [old],
      );
      await owner.query(
        "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
        [org, bundle],
      );
      for (const permission of ["channel.read", "channel.post"])
        await owner.query(
          "INSERT INTO permission_grants VALUES($1,$2,1,$3,'subtree')",
          [org, bundle, permission],
        );
      await owner.query(
        "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic ordinary member',$4,1)",
        [org, position, a, bundle],
      );
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
        [org, member, a, position],
      );
      await owner.query("COMMIT");
      try {
        const mine = await list(3);
        assert.ok(mine.total > 0);
        assert.ok(mine.items.every((r: any) => !r.action));
        assert.equal((await detail(3, pending.restrictionId)).mine, true);
        const foreignChannel = (
          await write(2, "create", {
            unitId: a,
            title: "Synthetic separate subject",
          })
        ).id;
        const foreignMessage = (
          await write(1, "post", {
            id: foreignChannel,
            body: "Synthetic unrelated member",
          })
        ).messageId;
        const foreign = (
          await write(2, "restrict", {
            id: foreignChannel,
            messageId: foreignMessage,
            reason: "Synthetic unrelated restriction",
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          })
        ).restrictionId;
        assert.ok(!(await list(3)).items.some((r: any) => r.id === foreign));
        await denied(detail(3, foreign));
        await denied(read(3, foreign, 1));
        assert.ok(
          (await inbox(3, "summary")).contexts.some((c: any) => c.id === org),
        );
      } finally {
        await owner.query(
          "UPDATE memberships SET status='ended' WHERE position_id=$1",
          [position],
        );
        await owner.query(
          "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
          [old],
        );
      }
    },
  );
  await check(
    "task-linked notices require current Work authority in addition to channel access",
    async () => {
      const { enableDemoWork } = await import("./web-demo-work"),
        { workCommand } = await import("../backend/src/modules/work/tasks");
      await owner.query("BEGIN");
      await enableDemoWork(owner, access);
      await owner.query("COMMIT");
      const task = await workCommand(sessions[2], "create", {
        organizationId: org,
        key: randomUUID(),
        unitId: a,
        title: "Synthetic moderated task",
        description: "Synthetic task",
        roleLabel: "Volunteer",
        priority: "normal",
        capacity: 1,
        deadline: new Date(Date.now() + 3600000).toISOString(),
      });
      const channel = (await write(2, "work-create", { workId: task.id })).id;
      const msg = (
        await write(3, "post", {
          id: channel,
          body: "Synthetic task participant message",
        })
      ).messageId;
      const restriction = (
        await write(2, "restrict", {
          id: channel,
          messageId: msg,
          reason: "Synthetic task restriction reason",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        })
      ).restrictionId;
      const member = access.accounts[3].memberId;
      const grants = (
        await owner.query(
          "SELECT DISTINCT m.id FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id JOIN permission_grants g ON g.organization_id=p.organization_id AND g.bundle_id=p.bundle_id AND g.bundle_version=p.bundle_version WHERE m.user_id=$1 AND g.permission='workitem.create'",
          [member],
        )
      ).rows.map((r) => r.id);
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
        [grants],
      );
      try {
        assert.ok(
          !(await list(3)).items.some((r: any) => r.id === restriction),
        );
        await denied(detail(3, restriction));
        await denied(read(3, restriction, 1));
      } finally {
        await owner.query(
          "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
          [grants],
        );
      }
    },
  );

  console.log("Moderation inbox: " + checks + " database scenarios passed");
  if (process.argv.includes("--browser")) {
    const channel = (
      await write(2, "create", {
        unitId: a,
        title: "Synthetic browser moderation",
      })
    ).id;
    await write(3, "post", {
      id: channel,
      body: "Synthetic browser participant message",
    });
    await (
      await import("./channel-restrictions-browser")
    ).verifyRestrictionsBrowser(app, access, true);
    assert.equal(
      (await command(3, "thread", { id: channel })).channel.canPost,
      true,
    );
    console.log(
      "PASS moderation notice browser journey and restored posting authority",
    );
  }
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created)
    await control.query("DROP DATABASE " + database + " WITH (FORCE)");
  await control.end();
}
