import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_decision_inbox_test_${randomBytes(8).toString("hex")}`,
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
    { enableDemoDecisions } = await import("./web-demo-decisions");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { decisionCommand } =
    await import("../backend/src/modules/decisions/polls");
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
    op: Parameters<typeof decisionCommand>[1],
    input: object = {},
  ) =>
    decisionCommand(
      sessions[i],
      op,
      op === "contexts" ? input : { organizationId: org, ...input },
    );
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
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
    inbox(i, "list", { source: "decision", view: "all", ...extra });
  const read = (i: number, id: string, version: number) =>
    inbox(i, "read", { source: "decision", id, version });
  const fresh = (extra: object = {}) => ({
    key: randomUUID(),
    unitId: a,
    title: "Synthetic inbox poll",
    description: "Private synthetic description",
    options: ["Choice A", "Choice B"],
    quorum: 50,
    closesAt: new Date(Date.now() + 3600000).toISOString(),
    ...extra,
  });
  const transition = async (
    i: number,
    op: "publish" | "close" | "cancel",
    id: string,
  ) =>
    command(i, op, {
      id,
      key: randomUUID(),
      version: (await command(i, "detail", { id })).version,
    });
  await owner.query("BEGIN");
  await enableDemoDecisions(owner, access);
  await owner.query("COMMIT");
  const poll = await command(2, "create", fresh()),
    id = poll.id;
  await check(
    "drafts stay out of the inbox; publication targets current electorate and scoped managers",
    async () => {
      assert.equal((await list(2)).total, 0);
      await transition(2, "publish", id);
      assert.equal((await list(3)).items[0].action, "decision_participate");
      assert.equal((await list(0)).items[0].action, "");
      assert.equal((await list(4)).total, 0);
      await denied(read(4, id, 1));
      const row = (await list(3)).items[0];
      assert.equal(row.version, 1);
      assert.equal(row.unread, true);
      for (const key of [
        "answers",
        "choice",
        "options",
        "description",
        "results",
        "voted",
        "electorate",
      ])
        assert.ok(!(key in row));
      assert.ok(!JSON.stringify(row).includes(access.accounts[2].memberId));
      await assert.rejects(
        db.query("SELECT * FROM ertad.decision_inbox_reads"),
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
    "reading is independent of participation and another recipient; votes do not create new notice versions",
    async () => {
      await read(3, id, 1);
      await read(3, id, 1);
      assert.equal((await list(3)).items[0].unread, false);
      assert.equal((await list(3, { view: "action" })).total, 1);
      assert.equal((await command(3, "detail", { id })).voted, false);
      assert.equal((await list(2)).items[0].unread, true);
      await command(3, "vote", { id, key: randomUUID(), choice: 0 });
      assert.equal((await list(3, { view: "action" })).total, 0);
      assert.equal((await list(3)).items[0].version, 1);
      assert.equal((await list(3)).items[0].unread, false);
      assert.equal((await list(2)).items[0].version, 1);
    },
  );
  await check(
    "deadline expiry becomes unread without a scheduler; stale acknowledgements preserve closure and cancellation",
    async () => {
      await owner.query(
        "UPDATE decisions SET closes_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2",
        [org, id],
      );
      assert.equal((await list(3)).items[0].version, 2);
      assert.equal((await list(3)).items[0].status, "closed");
      assert.equal((await list(3)).items[0].action, "");
      await read(3, id, 1);
      assert.equal((await list(3)).items[0].unread, true);
      await read(3, id, 2);
      await denied(read(3, id, 3), 409);
      await transition(2, "close", id);
      assert.equal((await list(3)).items[0].version, 3);
      assert.equal((await list(3)).items[0].action, "");
      await read(3, id, 2);
      assert.equal((await list(3)).items[0].unread, true);
      const cancel = await command(
        2,
        "create",
        fresh({ title: "Synthetic cancelled notice" }),
      );
      await transition(2, "publish", cancel.id);
      await read(3, cancel.id, 1);
      await transition(2, "cancel", cancel.id);
      assert.equal(
        (await list(3)).items.find((x: any) => x.id === cancel.id).version,
        4,
      );
      await read(3, cancel.id, 1);
      assert.equal(
        (await list(3)).items.find((x: any) => x.id === cancel.id).unread,
        true,
      );
    },
  );
  const ids: Record<string, string> = { poll: id };
  await check(
    "all four named formats share notices; survey participation uses responses rather than ballot rows",
    async () => {
      for (const kind of ["referendum", "election", "survey"]) {
        const extra =
          kind === "survey"
            ? {
                options: [],
                questions: [
                  {
                    id: randomUUID(),
                    type: "text",
                    title: "Synthetic question",
                    required: true,
                    maxLength: 500,
                  },
                ],
                kind,
              }
            : kind === "referendum"
              ? { kind, threshold: 50, options: ["Yes", "No", "Abstain"] }
              : { kind };
        const item = await command(
          2,
          "create",
          fresh({ title: "Synthetic inbox " + kind, ...extra }),
        );
        ids[kind] = item.id;
        await transition(2, "publish", item.id);
        assert.equal(
          (await list(3, { view: "action" })).items.find(
            (x: any) => x.id === item.id,
          ).action,
          "decision_participate",
        );
        if (kind === "survey") {
          const detail = await command(3, "detail", { id: item.id });
          await command(3, "vote", {
            id: item.id,
            key: randomUUID(),
            answers: {
              [detail.questions[0].id]: "SYNTHETIC_ANSWER_NOT_IN_NOTIFICATION",
            },
          });
          assert.ok(
            !(await list(3, { view: "action" })).items.some(
              (x: any) => x.id === item.id,
            ),
          );
          assert.ok(
            !JSON.stringify(await list(2)).includes(
              "SYNTHETIC_ANSWER_NOT_IN_NOTIFICATION",
            ),
          );
        }
      }
    },
  );
  await check(
    "revoked Decision membership removes notices despite unrelated active memberships",
    async () => {
      const member = access.accounts[3].memberId;
      const old = (
        await owner.query(
          "SELECT m.* FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.user_id=$1 AND p.name='Decisions demo'",
          [member],
        )
      ).rows[0];
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE organization_id=$1 AND id=$2",
        [org, old.id],
      );
      try {
        assert.equal((await list(3)).total, 0);
        await denied(read(3, id, 1));
      } finally {
        await owner.query(
          "UPDATE memberships SET status='active' WHERE organization_id=$1 AND id=$2",
          [org, old.id],
        );
      }
    },
  );
  await check(
    "moved hierarchy hides frozen notices even from council and denies stale read",
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
        assert.equal((await list(0)).total, 0);
        assert.equal((await list(3)).total, 0);
        await denied(read(0, id, 1));
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, a, parent],
        );
      }
    },
  );
  await check(
    "audit failure rolls back read state; actual permission expiry during audit denies acknowledgement",
    async () => {
      const target = ids.election,
        audit = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic audit failure");
      };
      try {
        await assert.rejects(read(3, target, 1), /Synthetic audit failure/);
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal(
        (await list(3)).items.find((x: any) => x.id === target).unread,
        true,
      );
      const authority = (
        await owner.query(
          "SELECT m.id,m.valid_until FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.user_id=$1 AND p.name='Decisions demo'",
          [access.accounts[3].memberId],
        )
      ).rows[0];
      await owner.query(
        "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",
        [authority.id],
      );
      SecurityService.logAuditEventInTransaction = async (client, ...args) => {
        await audit.call(SecurityService, client, ...args);
        await client.query("SELECT pg_sleep(3)");
      };
      try {
        await denied(read(3, target, 1));
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
        await owner.query("UPDATE memberships SET valid_until=$2 WHERE id=$1", [
          authority.id,
          authority.valid_until,
        ]);
      }
      assert.equal(
        (await list(3)).items.find((x: any) => x.id === target).unread,
        true,
      );
    },
  );
  await check(
    "HTTP filters, session, CSRF, Origin and submitted actor fields remain enforced",
    async () => {
      await request(app)
        .get(base + "/inbox")
        .query({ organizationId: org, source: "decision" })
        .expect(401);
      await sessions[3].agent
        .get(base + "/inbox")
        .query({ organizationId: org, source: "decision" })
        .expect(200);
      const body = {
        organizationId: org,
        source: "decision",
        id: ids.election,
        version: 1,
      };
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", origin)
        .send(body)
        .expect(403);
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", "https://invalid.example")
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(body)
        .expect(403);
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send({ ...body, actorId: access.accounts[2].memberId })
        .expect(400);
      await sessions[3].agent
        .post(base + "/inbox/read")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(body)
        .expect(200);
    },
  );
  await check(
    "a vote-only group member receives ancestor notices without unit metadata or management powers",
    async () => {
      const member = access.accounts[5].memberId,
        group = (
          await owner.query(
            "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 LIMIT 1",
            [org, a],
          )
        ).rows[0].id;
      const previous = (
        await owner.query(
          "SELECT id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, member],
        )
      ).rows.map((r) => r.id);
      const bundle = randomUUID(),
        position = randomUUID(),
        membership = randomUUID();
      await owner.query("BEGIN");
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
        [previous],
      );
      await owner.query(
        "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO permission_grants VALUES($1,$2,1,'decision.vote','unit')",
        [org, bundle],
      );
      await owner.query(
        "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic vote-only member',$4,1)",
        [org, position, group, bundle],
      );
      await owner.query(
        "INSERT INTO memberships(organization_id,id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,1,now(),now()+interval '1 day')",
        [org, membership, member, group, position],
      );
      await owner.query("COMMIT");
      try {
        assert.equal((await list(5)).total, 0); // New grants do not enter old electorates.
        const parent = await command(
          0,
          "create",
          fresh({
            unitId: access.accounts[0].unitId,
            title: "Synthetic ancestor participation",
          }),
        );
        await transition(0, "publish", parent.id);
        assert.ok(
          (await inbox(5, "summary")).contexts.some((c: any) => c.id === org),
        );
        const row = (await list(5)).items[0];
        assert.equal(row.id, parent.id);
        assert.equal(row.unitName, null);
        assert.equal(row.action, "decision_participate");
        await read(5, parent.id, 1);
        assert.equal(
          (await command(5, "detail", { id: parent.id })).canVote,
          true,
        );
        await owner.query(
          "UPDATE decisions SET closes_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2",
          [org, parent.id],
        );
        assert.equal((await list(5)).items[0].action, "");
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE id=$1",
          [membership],
        );
        await owner.query(
          "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
          [org, member, group, position],
        );
        assert.equal((await list(5)).total, 0); // Replacement membership does not revive the frozen one.
      } finally {
        await owner.query(
          "UPDATE memberships SET status='ended' WHERE organization_id=$1 AND position_id=$2",
          [org, position],
        );
        await owner.query(
          "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
          [previous],
        );
      }
    },
  );
  console.log(`Decision inbox: ${checks} database scenarios passed`);
  if (process.argv.includes("--browser"))
    await (
      await import("./decision-inbox-browser")
    ).verifyDecisionInboxBrowser(app, access, ids);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
