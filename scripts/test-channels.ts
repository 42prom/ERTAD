import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_channels_test_${randomBytes(8).toString("hex")}`,
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
  await check(
    "position names and existing hierarchy do not grant conversation access",
    async () => {
      assert.deepEqual(await command(2, "contexts"), []);
      await denied(command(2, "list"));
    },
  );
  await owner.query("BEGIN");
  await enableDemoChannels(owner, access);
  await owner.query("COMMIT");
  const input = {
      key: randomUUID(),
      unitId: a,
      title: "Synthetic regional conversation",
    },
    channel = await command(2, "create", input),
    id = channel.id;
  const thread = (i: number, extra: object = {}) =>
    command(i, "thread", { id, ...extra });
  let first: any, second: any;
  await check(
    "scoped creation, idempotent retries and restricted database capabilities",
    async () => {
      assert.deepEqual(await command(2, "create", input), channel);
      await denied(
        command(2, "create", { ...input, title: "Conflicting title" }),
        409,
      );
      assert.equal((await command(3, "list")).total, 1);
      assert.equal((await command(0, "list")).total, 1);
      assert.equal((await command(4, "list")).total, 0);
      await denied(thread(4));
      await denied(write(4, "post", { id, body: "Wrong region" }));
      await denied(
        write(2, "create", { unitId: b, title: "Wrong region channel" }),
      );
      await denied(command(3, "thread", { id, organizationId: randomUUID() }));
      await assert.rejects(
        db.query("SELECT * FROM ertad.channel_messages"),
        (e: any) => e.code === "42501",
      );
    },
  );
  const secret = "SYNTHETIC_PRIVATE_TEXT_NEVER_IN_AUDIT";
  await check(
    "concurrent retry sends once, reply remains in-channel and author IDs are private",
    async () => {
      const message = { id, key: randomUUID(), body: secret };
      const result = await Promise.all([
        command(2, "post", message),
        command(2, "post", message),
      ]);
      assert.deepEqual(result[0], result[1]);
      first = result[0];
      await denied(
        command(2, "post", { ...message, body: "Changed retry" }),
        409,
      );
      second = await write(3, "post", {
        id,
        body: "Synthetic independent reply",
        replyId: first.messageId,
      });
      const data = await thread(3);
      assert.equal(data.items.length, 2);
      assert.equal(data.items[1].replySeq, 1);
      assert.equal(data.items[1].mine, true);
      assert.ok(!JSON.stringify(data).includes(access.accounts[2].memberId));
      assert.ok(!JSON.stringify(data).includes(access.accounts[2].email));
      const other = await write(2, "create", {
        unitId: a,
        title: "Other synthetic channel",
      });
      await denied(
        write(2, "post", {
          id: other.id,
          body: "Wrong channel reply",
          replyId: first.messageId,
        }),
        409,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM audit_log WHERE payload LIKE $1",
            ["%" + secret + "%"],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM channel_receipts WHERE response::text LIKE $1",
            ["%" + secret + "%"],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await check(
    "read acknowledgements preserve new arrivals; mute does not delete or mark content read",
    async () => {
      assert.equal((await thread(3)).channel.unread, 1);
      const read = { id, key: randomUUID(), seq: 1 };
      await command(3, "read", read);
      await write(2, "post", { id, body: "Synthetic new arrival" });
      await command(3, "read", read);
      assert.equal((await thread(3)).channel.unread, 1);
      await write(3, "mute", { id, muted: true });
      assert.equal((await thread(3)).channel.unread, 0);
      assert.equal((await thread(3)).items.length, 3);
      await write(3, "mute", { id, muted: false });
      assert.equal((await thread(3)).channel.unread, 1);
      await denied(write(3, "read", { id, seq: 4 }), 409);
      assert.equal((await thread(3)).channel.readSeq, 1);
    },
  );
  await check(
    "independent report resolution erases the canonical body without exposing reporters",
    async () => {
      await write(3, "report", {
        id,
        messageId: first.messageId,
        category: "privacy",
      });
      await write(3, "report", {
        id,
        messageId: first.messageId,
        category: "privacy",
      });
      assert.equal((await command(3, "reports", { id })).total, 0);
      assert.equal((await command(2, "reports", { id })).total, 0);
      const reports = await command(0, "reports", { id });
      assert.equal(reports.total, 1);
      assert.ok(!JSON.stringify(reports).includes(access.accounts[3].memberId));
      const reportId = reports.items[0].id;
      await denied(write(2, "resolve", { id, reportId, outcome: "remove" }));
      await denied(write(3, "resolve", { id, reportId, outcome: "remove" }));
      await denied(
        write(2, "report", {
          id,
          messageId: first.messageId,
          category: "spam",
        }),
      );
      await write(0, "resolve", { id, reportId, outcome: "remove" });
      const data = await thread(3);
      assert.equal(data.items[0].removed, true);
      assert.equal(data.items[0].body, "");
      assert.equal(data.items[1].replySeq, 1);
      assert.ok(!JSON.stringify(data).includes(secret));
      await denied(
        write(3, "post", {
          id,
          replyId: first.messageId,
          body: "Reply to erased text",
        }),
        409,
      );
      await denied(write(2, "remove", { id, messageId: second.messageId }));
      await write(3, "remove", { id, messageId: second.messageId });
      assert.equal((await thread(2)).items[1].body, "");
      assert.equal(
        (
          await owner.query(
            "SELECT body FROM channel_messages WHERE organization_id=$1 AND channel_id=$2 AND id=$3",
            [org, id, first.messageId],
          )
        ).rows[0].body,
        "",
      );
    },
  );
  await check(
    "archive is versioned and new messages are denied until explicit reopening",
    async () => {
      const version = (await thread(2)).channel.version;
      await write(2, "archive", { id, version, archived: true });
      await denied(write(3, "post", { id, body: "Archived write" }), 409);
      assert.equal(
        (await command(3, "list", { view: "archived" })).items[0].id,
        id,
      );
      await denied(write(2, "archive", { id, version, archived: false }), 409);
      await write(2, "archive", { id, version: version + 1, archived: false });
    },
  );
  const { SecurityService } = await import("../backend/src/services/security");
  await check(
    "audit failure rolls back body, sequence and retry receipt",
    async () => {
      const audit = SecurityService.logAuditEventInTransaction,
        before = (await thread(2)).channel.lastSeq;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic audit failure");
      };
      try {
        await assert.rejects(
          write(2, "post", { id, body: "Must not survive rollback" }),
          /Synthetic audit failure/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal((await thread(2)).channel.lastSeq, before);
      assert.ok(
        !(await thread(2)).items.some(
          (m: any) => m.body === "Must not survive rollback",
        ),
      );
    },
  );
  await check(
    "real permission expiry during audit rolls back a post and hides all records",
    async () => {
      const authority = (
        await owner.query(
          "SELECT m.id,m.valid_until FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.user_id=$1 AND p.name='Channel operations demo'",
          [access.accounts[2].memberId],
        )
      ).rows[0];
      const before = (await thread(3)).channel.lastSeq,
        audit = SecurityService.logAuditEventInTransaction;
      await owner.query(
        "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [authority.id],
      );
      SecurityService.logAuditEventInTransaction = async (client, ...args) => {
        await audit.call(SecurityService, client, ...args);
        await client.query("SELECT pg_sleep(3)");
      };
      try {
        await denied(
          write(2, "post", { id, body: "Authority expires during audit" }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal((await thread(3)).channel.lastSeq, before);
      await denied(thread(2));
      await owner.query("UPDATE memberships SET valid_until=$2 WHERE id=$1", [
        authority.id,
        authority.valid_until,
      ]);
    },
  );
  await check(
    "hierarchy movement invalidates the stored conversation scope",
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
        await denied(thread(2));
        await denied(thread(0));
        assert.equal((await command(3, "list")).total, 0);
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, a, parent],
        );
      }
    },
  );
  await check(
    "HTTP session, CSRF, Origin and strict body boundaries",
    async () => {
      await request(app)
        .get(base + "/channels/contexts")
        .expect(401);
      const body = {
        organizationId: org,
        id,
        key: randomUUID(),
        body: "Synthetic HTTP message",
      };
      await sessions[3].agent
        .post(base + "/channels/post")
        .set("Origin", origin)
        .send(body)
        .expect(403);
      await sessions[3].agent
        .post(base + "/channels/post")
        .set("Origin", "https://invalid.example")
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(body)
        .expect(403);
      await sessions[3].agent
        .post(base + "/channels/post")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send({ ...body, authorId: access.accounts[0].memberId })
        .expect(400);
      await sessions[3].agent
        .post(base + "/channels/post")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(body)
        .expect(200);
    },
  );
  await check(
    "keyset history preserves ordering when new messages arrive; posting is bounded",
    async () => {
      // Historical fixtures keep the rate test independent of time spent in earlier cases.
      await owner.query(
        `INSERT INTO channel_messages(organization_id,channel_id,seq,author_id,body,created_at)
    SELECT $1,$2,c.last_seq+n,$3,'Synthetic history '||n,now()-interval '1 day' FROM channels c CROSS JOIN generate_series(1,45) n WHERE c.organization_id=$1 AND c.id=$2`,
        [org, id, access.accounts[2].memberId],
      );
      await owner.query(
        "UPDATE channels SET last_seq=last_seq+45 WHERE organization_id=$1 AND id=$2",
        [org, id],
      );
      const latest = await thread(3);
      assert.equal(latest.items.length, 40);
      assert.equal(latest.hasOlder, true);
      const cursor = latest.items[0].seq;
      await write(3, "post", { id, body: "Arrival between history pages" });
      const older = await thread(3, { before: cursor });
      assert.ok(older.items.every((m: any) => m.seq < cursor));
      assert.equal(
        new Set([...latest.items, ...older.items].map((m: any) => m.id)).size,
        latest.channel.lastSeq,
      );
      for (let i = 0; i < 20; i++) {
        try {
          await write(3, "post", { id, body: "Synthetic burst " + i });
        } catch (e: any) {
          assert.equal(e.statusCode, 429);
          break;
        }
      }
      await denied(write(3, "post", { id, body: "Over the limit" }), 429);
    },
  );
  await check(
    "ordinary group grants allow conversation but confer no management or other-group visibility",
    async () => {
      const group = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 ORDER BY id LIMIT 1",
          [org, a],
        )
      ).rows[0].id;
      const bundle = randomUUID(),
        position = randomUUID(),
        member = access.accounts[5].memberId;
      await owner.query("BEGIN");
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
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic group conversation member',$4,1)",
        [org, position, group, bundle],
      );
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE user_id=$1 AND position_id IN(SELECT id FROM positions WHERE name='Channel operations demo')",
        [member],
      );
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
        [org, member, group, position],
      );
      await owner.query("COMMIT");
      const target = await write(2, "create", {
        unitId: group,
        title: "Synthetic group conversation",
      });
      await write(5, "post", {
        id: target.id,
        body: "Ordinary group contribution",
      });
      const data = await command(5, "thread", { id: target.id });
      assert.equal(data.channel.canPost, true);
      assert.equal(data.channel.canManage, false);
      assert.equal(data.channel.canModerate, false);
      assert.equal((await command(5, "list")).total, 1);
      await denied(thread(5));
      await denied(
        write(5, "create", { unitId: group, title: "Unauthorized channel" }),
      );
      await denied(command(5, "reports", { id: target.id }));
      await denied(
        write(5, "archive", { id: target.id, version: 1, archived: true }),
      );
      await denied(command(4, "thread", { id: target.id }));
    },
  );
  await check("reopening cannot bypass the active channel limit", async () => {
    const fixtures = (
      await owner.query(
        `INSERT INTO channels(organization_id,unit_id,scope_path,title,creator_id,archived)
       SELECT $1,$2,ertad.unit_path($1,$2),'Synthetic channel limit '||n,$3,n=51
       FROM generate_series(1,51) n RETURNING id,archived`,
        [org, b, access.accounts[4].memberId],
      )
    ).rows;
    try {
      const archived = fixtures.find((r) => r.archived).id;
      await denied(
        write(4, "create", { unitId: b, title: "Excess active channel" }),
        409,
      );
      await denied(
        write(4, "archive", { id: archived, version: 1, archived: false }),
        409,
      );
      await write(4, "archive", {
        id: fixtures.find((r) => !r.archived).id,
        version: 1,
        archived: true,
      });
      await write(4, "archive", { id: archived, version: 1, archived: false });
      assert.equal(
        (await command(4, "thread", { id: archived })).channel.archived,
        false,
      );
    } finally {
      await owner.query(
        "DELETE FROM channels WHERE organization_id=$1 AND id=ANY($2::uuid[])",
        [org, fixtures.map((r) => r.id)],
      );
    }
  });
  console.log(`Channels: ${checks} database scenarios passed`);
  if (process.argv.includes("--browser"))
    await (
      await import("./channels-browser")
    ).verifyChannelsBrowser(app, access);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
