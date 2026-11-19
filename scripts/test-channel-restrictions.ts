import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_moderation_test_${randomBytes(8).toString("hex")}`,
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
  const id = (
    await write(2, "create", {
      unitId: a,
      title: "Synthetic moderation channel",
    })
  ).id;
  const message = (
    await write(3, "post", { id, body: "Synthetic participant message" })
  ).messageId;
  const reason = "Synthetic policy violation";
  const definition = (messageId = message) => ({
    id,
    messageId,
    reason,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  let restrictionId = "";
  await check(
    "self, sibling and original reporter cannot impose a restriction",
    async () => {
      await denied(write(3, "restrict", definition()));
      await denied(write(4, "restrict", definition()));
      await write(0, "report", { id, messageId: message, category: "abuse" });
      await denied(write(0, "restrict", definition()));
    },
  );
  await check(
    "concurrent retry creates one restriction and private reasons do not enter receipts",
    async () => {
      const payload = { ...definition(), key: randomUUID() };
      const [x, y] = await Promise.all([
        command(2, "restrict", payload),
        command(2, "restrict", payload),
      ]);
      assert.equal(x.restrictionId, y.restrictionId);
      restrictionId = x.restrictionId;
      await denied(
        command(2, "restrict", {
          ...payload,
          reason: "Different synthetic reason",
        }),
        409,
      );
      await denied(write(1, "restrict", definition()), 409);
      assert.equal(
        (await owner.query("SELECT count(*)::int n FROM channel_restrictions"))
          .rows[0].n,
        1,
      );
      const receipt = (
        await owner.query(
          "SELECT response FROM channel_receipts WHERE key=$1",
          [payload.key],
        )
      ).rows[0].response;
      assert.equal(JSON.stringify(receipt).includes(reason), false);
      await assert.rejects(
        db.query("SELECT * FROM ertad.channel_restrictions"),
        (e: any) => e.code === "42501",
      );
      await assert.rejects(
        db.query("SELECT ertad.channel_content_command($1,$2,$3,$4,$5,$6)", [
          sessions[3].sessionId,
          sessions[3].sessionTokenHash,
          "post",
          org,
          JSON.stringify({ id, body: "bypass", key: randomUUID() }),
          "a".repeat(64),
        ]),
        (e: any) => e.code === "42501",
      );
    },
  );
  await check(
    "restricted members keep read and appeal access without affecting other channels",
    async () => {
      const view = await command(3, "thread", { id });
      assert.equal(view.channel.canPost, false);
      assert.equal(view.channel.postingRestriction.id, restrictionId);
      assert.equal(view.items.length, 1);
      await denied(write(3, "post", { id, body: "Must fail" }));
      await write(3, "read", { id, seq: 1 });
      await write(3, "mute", { id, muted: true });
      const other = (
        await write(2, "create", {
          unitId: a,
          title: "Synthetic unaffected channel",
        })
      ).id;
      await write(3, "post", {
        id: other,
        body: "Unrelated channel remains available",
      });
      assert.equal(
        (await command(4, "restrictions", { view: "history" })).total,
        0,
      );
      const mine = (await command(3, "restrictions", { view: "mine" }))
        .items[0];
      assert.equal(mine.canAppeal, true);
      assert.equal(mine.canReview, false);
      for (const field of ["subjectId", "issuerId", "reviewerId", "messageId"])
        assert.equal(field in mine, false);
      await denied(
        write(2, "appeal", {
          id,
          restrictionId,
          version: 1,
          reason: "I am not the affected member",
        }),
      );
      await write(3, "appeal", {
        id,
        restrictionId,
        version: 1,
        reason: "Synthetic request for independent review",
      });
      await denied(
        write(3, "appeal", {
          id,
          restrictionId,
          version: 1,
          reason: "Duplicate appeal must fail",
        }),
        409,
      );
    },
  );
  await check(
    "only a current independent reviewer can lift a restriction",
    async () => {
      for (const i of [0, 2, 3, 4]) {
        assert.equal(
          (await command(i, "restrictions", { view: "pending" })).total,
          0,
        );
        await denied(
          write(i, "review-appeal", {
            id,
            restrictionId,
            version: 2,
            reason: "Synthetic review reason",
            outcome: "lift",
          }),
        );
      }
      const pending = (await command(1, "restrictions", { view: "pending" }))
        .items;
      assert.equal(pending.length, 1);
      assert.equal(pending[0].canReview, true);
      await denied(
        write(1, "review-appeal", {
          id,
          restrictionId,
          version: 1,
          reason: "Stale version review",
          outcome: "lift",
        }),
        409,
      );
      const payload = {
        id,
        restrictionId,
        version: 2,
        reason: "Synthetic independent reversal",
        outcome: "lift",
        key: randomUUID(),
      };
      await command(1, "review-appeal", payload);
      await command(1, "review-appeal", payload);
      assert.equal(
        (await command(1, "restrictions", { view: "pending" })).total,
        0,
      );
      assert.equal((await command(3, "thread", { id })).channel.canPost, true);
      await write(3, "post", { id, body: "Allowed after lift" });
      await assert.rejects(
        owner.query(
          "UPDATE channel_restrictions SET reason='Changed history' WHERE id=$1",
          [restrictionId],
        ),
        (e: any) => e.code === "23514",
      );
      await assert.rejects(
        owner.query("DELETE FROM channel_restrictions WHERE id=$1", [
          restrictionId,
        ]),
        (e: any) => e.code === "23514",
      );
    },
  );
  await check(
    "upheld restrictions expire without a scheduler or extension on review",
    async () => {
      const msg = (
        await write(3, "post", { id, body: "Synthetic timed restriction" })
      ).messageId;
      const short = (
        await write(2, "restrict", {
          ...definition(msg),
          expiresAt: new Date(Date.now() + 8000).toISOString(),
        })
      ).restrictionId;
      await write(3, "appeal", {
        id,
        restrictionId: short,
        version: 1,
        reason: "Synthetic timed appeal",
      });
      await write(1, "review-appeal", {
        id,
        restrictionId: short,
        version: 2,
        reason: "Synthetic decision upheld",
        outcome: "uphold",
      });
      await denied(write(3, "post", { id, body: "Still restricted" }));
      await owner.query("SELECT pg_sleep(8)");
      assert.equal((await command(3, "thread", { id })).channel.canPost, true);
      assert.equal(
        (await command(3, "restrictions", { view: "mine" })).items.find(
          (x: any) => x.id === short,
        ).active,
        false,
      );
      await write(3, "post", { id, body: "Allowed after actual expiry" });
    },
  );
  const { SecurityService } = await import("../backend/src/services/security");
  await check(
    "audit failure rolls back creation and appeal decisions",
    async () => {
      const audit = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic moderation audit failure");
      };
      try {
        await assert.rejects(
          write(2, "restrict", definition()),
          /Synthetic moderation audit failure/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal((await command(3, "thread", { id })).channel.canPost, true);
      restrictionId = (await write(2, "restrict", definition())).restrictionId;
      await write(3, "appeal", {
        id,
        restrictionId,
        version: 1,
        reason: "Synthetic rollback appeal",
      });
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic moderation audit failure");
      };
      try {
        await assert.rejects(
          write(1, "review-appeal", {
            id,
            restrictionId,
            version: 2,
            reason: "Synthetic rollback review",
            outcome: "lift",
          }),
          /Synthetic moderation audit failure/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal((await command(3, "thread", { id })).channel.canPost, false);
      assert.equal(
        (await command(1, "restrictions", { view: "pending" })).total,
        1,
      );
    },
  );
  await check(
    "actual moderator grant expiry during audit rolls back a decision",
    async () => {
      const member = access.accounts[1].memberId;
      const grant = (
        await owner.query(
          "SELECT m.id,m.valid_until FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.user_id=$1 AND p.name='Channel operations demo'",
          [member],
        )
      ).rows[0];
      const audit = SecurityService.logAuditEventInTransaction;
      await owner.query(
        "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [grant.id],
      );
      SecurityService.logAuditEventInTransaction = async (client, ...args) => {
        await audit.call(SecurityService, client, ...args);
        await client.query("SELECT pg_sleep(3)");
      };
      try {
        await denied(
          write(1, "review-appeal", {
            id,
            restrictionId,
            version: 2,
            reason: "Synthetic expired authority",
            outcome: "lift",
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
        await owner.query("UPDATE memberships SET valid_until=$2 WHERE id=$1", [
          grant.id,
          grant.valid_until,
        ]);
      }
      assert.equal(
        (await command(1, "restrictions", { view: "pending" })).total,
        1,
      );
    },
  );
  await check(
    "moving hierarchy hides restrictions and appeals from former managers",
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
        assert.equal(
          (await command(2, "restrictions", { view: "history" })).total,
          0,
        );
        await denied(command(3, "thread", { id }));
        await denied(
          write(1, "review-appeal", {
            id,
            restrictionId,
            version: 2,
            reason: "Moved hierarchy review",
            outcome: "lift",
          }),
        );
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, a, parent],
        );
      }
    },
  );
  await check(
    "HTTP and SQL reject forged identity, duration, session, Origin and CSRF",
    async () => {
      await request(app)
        .get(base + "/channels/restrictions")
        .query({ organizationId: org })
        .expect(401);
      const body = { organizationId: org, ...definition(), key: randomUUID() };
      await sessions[2].agent
        .post(base + "/channels/restrict")
        .set("Origin", origin)
        .send(body)
        .expect(403);
      await sessions[2].agent
        .post(base + "/channels/restrict")
        .set("Origin", "https://invalid.example")
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send(body)
        .expect(403);
      await sessions[2].agent
        .post(base + "/channels/restrict")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send({ ...body, subjectId: access.accounts[4].memberId })
        .expect(400);
      await denied(
        write(2, "restrict", {
          ...definition(),
          expiresAt: new Date(Date.now() + 31 * 86400000).toISOString(),
        }),
        400,
      );
      await assert.rejects(
        owner.query("SELECT ertad.channel_command($1,$2,$3,$4,$5,$6)", [
          sessions[2].sessionId,
          sessions[2].sessionTokenHash,
          "restrict",
          org,
          JSON.stringify({ ...definition(), key: randomUUID(), reason: "bad" }),
          "a".repeat(64),
        ]),
        (e: any) => e.code === "22023",
      );
    },
  );
  await check(
    "read/post-only members see only their own records and cannot moderate",
    async () => {
      const member = access.accounts[3].memberId;
      const old = (
        await owner.query(
          "SELECT m.id FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.user_id=$1 AND p.name='Channel operations demo'",
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
        const mine = await command(3, "restrictions", { view: "history" });
        assert.ok(mine.total > 0);
        assert.ok(mine.items.every((r: any) => r.mine && !r.canReview));
        assert.equal(
          (await command(3, "restrictions", { view: "pending" })).total,
          0,
        );
        await denied(
          write(3, "review-appeal", {
            id,
            restrictionId,
            version: 2,
            reason: "No moderator permission",
            outcome: "lift",
          }),
        );
        const msg = (
          await write(2, "post", { id, body: "Synthetic moderator message" })
        ).messageId;
        await denied(write(3, "restrict", definition(msg)));
        assert.equal(
          (await command(3, "thread", { id })).items.find(
            (m: any) => m.id === msg,
          ).canRestrict,
          false,
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
    "task-linked moderation retains Work authority and closed-task restrictions cannot be created",
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
        await write(2, "restrict", { ...definition(msg), id: channel })
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
          !(await command(3, "restrictions", { view: "mine" })).items.some(
            (r: any) => r.id === restriction,
          ),
        );
        await denied(
          write(3, "appeal", {
            id: channel,
            restrictionId: restriction,
            version: 1,
            reason: "Lost task authority appeal",
          }),
        );
      } finally {
        await owner.query(
          "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
          [grants],
        );
      }
      const detail = await workCommand(sessions[2], "detail", {
        organizationId: org,
        id: task.id,
      });
      await workCommand(sessions[2], "cancel", {
        organizationId: org,
        id: task.id,
        key: randomUUID(),
        version: detail.version,
        note: "Synthetic task cancellation",
      });
      const messages = await command(1, "thread", { id: channel });
      assert.equal(messages.channel.archived, true);
      assert.ok(messages.items.every((m: any) => !m.canRestrict));
      await denied(
        write(1, "restrict", { ...definition(msg), id: channel }),
        409,
      );
    },
  );
  console.log("Channel restrictions: " + checks + " database scenarios passed");
  if (process.argv.includes("--browser")) {
    const browserChannel = (
      await write(2, "create", {
        unitId: a,
        title: "Synthetic browser moderation",
      })
    ).id;
    await write(3, "post", {
      id: browserChannel,
      body: "Synthetic browser participant message",
    });
    await (
      await import("./channel-restrictions-browser")
    ).verifyRestrictionsBrowser(app, access);
    assert.equal(
      (await command(3, "thread", { id: browserChannel })).channel.canPost,
      true,
    );
    await write(3, "post", {
      id: browserChannel,
      body: "Synthetic message after browser appeal lift",
    });
    console.log("PASS restricted participant can post after browser decision");
  }
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created)
    await control.query("DROP DATABASE " + database + " WITH (FORCE)");
  await control.end();
}
