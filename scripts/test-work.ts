import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_work_test_${randomBytes(8).toString("hex")}`,
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
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
  await check("existing roles gain no implicit work authority", async () => {
    assert.deepEqual(await command(2, "contexts"), []);
  });
  await owner.query("BEGIN");
  await enableDemoWork(owner, access);
  await owner.query("COMMIT");
  const fresh = (unitId = a, capacity = 2) => ({
    key: randomUUID(),
    unitId,
    capacity,
    title: "Synthetic task",
    description: "Synthetic voluntary work",
    roleLabel: "Coordinator",
    priority: "normal",
    deadline: new Date(Date.now() + 3600000).toISOString(),
  });
  const detail = (i: number, id: string) => command(i, "detail", { id });
  const act = async (
    i: number,
    op: Parameters<typeof workCommand>[1],
    id: string,
    extra: object = {},
  ) =>
    command(i, op, {
      id,
      key: randomUUID(),
      version: (await detail(i, id)).version,
      ...extra,
    });
  let id = "";
  await check(
    "scoped creation, immutable retry payload and HTTP/CSRF boundaries",
    async () => {
      const input = fresh();
      const result = await command(2, "create", input);
      id = result.id;
      assert.deepEqual(await command(2, "create", input), result);
      await denied(
        command(2, "create", { ...input, title: "Different title" }),
        409,
      );
      await denied(detail(4, id));
      await denied(command(4, "create", fresh(a)));
      assert.equal((await command(4, "list")).total, 0);
      await sessions[2].agent
        .post(base + "/work/create")
        .set("Origin", origin)
        .send({ organizationId: org, ...fresh() })
        .expect(403);
      await sessions[2].agent
        .get(base + "/work/detail")
        .query({ organizationId: org, id })
        .expect(200);
      await denied(
        command(2, "create", { ...fresh(), role: "super_admin" }),
        400,
      );
      await assert.rejects(
        db.query("SELECT * FROM ertad.work_items"),
        (e: any) => e.code === "42501",
      );
    },
  );
  await check(
    "voluntary participation, bounded assignment, progress, independent verification and Activity",
    async () => {
      await denied(
        act(3, "assign", id, { memberId: access.accounts[2].memberId }),
        409,
      );
      await act(2, "apply", id);
      await act(3, "assign", id, { memberId: access.accounts[2].memberId });
      await act(2, "start", id);
      await act(2, "progress", id, {
        progress: 60,
        note: "Synthetic progress",
      });
      await act(2, "submit", id);
      await denied(
        act(2, "verify", id, { memberId: access.accounts[2].memberId }),
        409,
      );
      await act(0, "return", id, {
        memberId: access.accounts[2].memberId,
        note: "Add completion evidence",
      });
      await act(2, "submit", id, { note: "Evidence added" });
      const input = {
        id,
        key: randomUUID(),
        version: (await detail(3, id)).version,
        memberId: access.accounts[2].memberId,
      };
      await command(0, "verify", input);
      await command(0, "verify", input);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM activity_entries WHERE user_id=$1",
            [access.accounts[2].memberId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal((await detail(2, id)).verified, 1);
      await denied(
        act(3, "cancel", id, { note: "Cannot erase verified work" }),
        409,
      );
      await act(3, "complete", id);
      assert.equal((await detail(2, id)).status, "completed");
    },
  );
  await check(
    "hierarchical offers, partial acceptance and parent allocation accounting",
    async () => {
      const root = access.accounts[0].unitId;
      const parent = (await command(0, "create", fresh(root, 3))).id;
      const child = (
        await act(0, "delegate", parent, {
          ...fresh(a, 2),
          deadline: new Date((await detail(0, parent)).deadline).toISOString(),
        })
      ).id;
      assert.equal((await detail(2, child)).status, "offered");
      await denied(act(4, "accept", child, { capacity: 2 }));
      await denied(
        act(0, "delegate", parent, {
          ...fresh(b, 2),
          deadline: new Date((await detail(0, parent)).deadline).toISOString(),
        }),
        409,
      );
      await act(2, "accept", child, { capacity: 1 });
      assert.equal((await detail(0, parent)).used, 1);
      const second = (
        await act(0, "delegate", parent, {
          ...fresh(b, 2),
          deadline: new Date((await detail(0, parent)).deadline).toISOString(),
        })
      ).id;
      await act(4, "decline", second, { note: "No capacity this week" });
      assert.equal((await detail(0, parent)).used, 1);
      await denied(
        act(0, "cancel", parent, { note: "Children still active" }),
        409,
      );
      await act(2, "cancel", child, { note: "No participants available" });
      await act(0, "cancel", parent, { note: "Work rescheduled" });
    },
  );
  await check(
    "concurrent last slot, reserve, no-show, withdrawal and cancellation",
    async () => {
      id = (await command(2, "create", fresh(a, 1))).id;
      await act(2, "apply", id);
      await act(3, "apply", id);
      const version = (await detail(2, id)).version;
      const results = await Promise.allSettled(
        [2, 3].map((i) =>
          command(0, "assign", {
            id,
            key: randomUUID(),
            version,
            memberId: access.accounts[i].memberId,
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const d = await detail(0, id),
        winner = d.assignments.find((x: any) => x.status === "assigned"),
        loser = d.assignments.find((x: any) => x.status === "applied");
      await act(0, "reserve", id, { memberId: loser.memberId });
      await denied(act(0, "assign", id, { memberId: loser.memberId }), 409);
      await act(0, "no_show", id, {
        memberId: winner.memberId,
        note: "Did not arrive",
      });
      await act(0, "assign", id, { memberId: loser.memberId });
      const i = access.accounts.findIndex((x) => x.memberId === loser.memberId);
      await act(i, "withdraw", id);
      assert.equal((await detail(0, id)).used, 0);
      await act(0, "cancel", id, { note: "No remaining volunteers" });
    },
  );
  await check(
    "durable notifications and current scope acknowledgement",
    async () => {
      const inbox = await command(3, "list", { view: "inbox" });
      assert.ok(inbox.total > 0);
      const task = inbox.items[0];
      await command(3, "ack", { id: task.id, version: task.version });
      assert.equal((await detail(3, task.id)).unread, 0);
      await denied(command(4, "ack", { id: task.id, version: task.version }));
    },
  );
  const { SecurityService } = await import("../backend/src/services/security");
  const audit = SecurityService.logAuditEventInTransaction;
  await check(
    "strict audit failure rolls back work, history and notifications",
    async () => {
      const before = (
        await owner.query("SELECT count(*)::int n FROM work_items")
      ).rows[0].n;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic audit failure");
      };
      try {
        await assert.rejects(
          command(2, "create", fresh()),
          /Synthetic audit failure/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal(
        (await owner.query("SELECT count(*)::int n FROM work_items")).rows[0].n,
        before,
      );
    },
  );
  await check(
    "deadline expiry during audit rolls back allocation",
    async () => {
      const input = fresh();
      input.deadline = new Date(Date.now() + 700).toISOString();
      SecurityService.logAuditEventInTransaction = async (
        ...args: Parameters<typeof audit>
      ) => {
        await new Promise((r) => setTimeout(r, 800));
        return audit(...args);
      };
      try {
        await denied(command(2, "create", input), 409);
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
    },
  );
  await check(
    "immutable Activity and task history cannot be edited",
    async () => {
      await assert.rejects(owner.query("UPDATE activity_entries SET value=1"));
      await assert.rejects(owner.query("DELETE FROM work_events"));
    },
  );
  await check(
    "expired session loses access even during audited read",
    async () => {
      SecurityService.logAuditEventInTransaction = async (client, ...args) => {
        await client.query(
          "UPDATE ertad.admin_sessions SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [sessions[4].sessionId],
        );
        return audit(client, ...args);
      };
      try {
        await denied(command(4, "list"));
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
    },
  );
  await check(
    "group managers and ordinary participants obey the same hierarchy and privacy boundary",
    async () => {
      const group = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 AND kind='authority' ORDER BY id LIMIT 1",
          [org, a],
        )
      ).rows[0].id;
      const saved = (
        await owner.query(
          "SELECT id,status FROM memberships WHERE organization_id=$1 AND user_id=ANY($2::uuid[])",
          [org, [access.accounts[4].memberId, access.accounts[5].memberId]],
        )
      ).rows;
      const added: string[] = [];
      try {
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE organization_id=$1 AND user_id=ANY($2::uuid[])",
          [org, [access.accounts[4].memberId, access.accounts[5].memberId]],
        );
        for (const i of [4, 5]) {
          const bundle = randomUUID(),
            position = randomUUID();
          await owner.query(
            "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
            [org, bundle],
          );
          for (const permission of i === 4
            ? [
                "workitem.read",
                "workitem.create",
                "workitem.verify",
                "workitem.participate",
              ]
            : ["workitem.read", "workitem.participate"])
            await owner.query(
              "INSERT INTO permission_grants VALUES($1,$2,1,$3,'unit')",
              [org, bundle, permission],
            );
          await owner.query(
            "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
            [org, bundle],
          );
          await owner.query(
            "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic group work',$4,1)",
            [org, position, group, bundle],
          );
          added.push(
            (
              await owner.query(
                "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day') RETURNING id",
                [org, access.accounts[i].memberId, group, position],
              )
            ).rows[0].id,
          );
        }
        const parent = (await command(2, "create", fresh(a, 2))).id;
        const child = (
          await act(2, "delegate", parent, {
            ...fresh(group, 2),
            deadline: new Date(
              (await detail(2, parent)).deadline,
            ).toISOString(),
          })
        ).id;
        await denied(detail(4, parent));
        await denied(command(4, "create", fresh(a)));
        await denied(command(5, "create", fresh(group)));
        const groupCreated = (await command(4, "create", fresh(group))).id;
        assert.equal((await detail(4, groupCreated)).unitId, group);
        await act(4, "cancel", groupCreated, {
          note: "Synthetic group creation check completed",
        });
        await act(4, "accept", child, { capacity: 2 });
        await act(5, "apply", child);
        await act(2, "apply", child);
        assert.equal((await detail(5, child)).assignments.length, 1);
        assert.ok(
          (await detail(5, child)).events.every(
            (e: any) =>
              !e.subjectId || e.subjectId === access.accounts[5].memberId,
          ),
        );
        await denied(
          act(5, "assign", child, { memberId: access.accounts[5].memberId }),
        );
        await act(4, "assign", child, {
          memberId: access.accounts[5].memberId,
        });
        await act(5, "start", child);
        await act(5, "block", child, {
          kind: "resource",
          note: "Synthetic equipment shortfall",
          nextReviewAt: new Date(Date.now() + 3600000).toISOString(),
        });
        const blocker = (await detail(4, child)).blockerRecords[0].id;
        await denied(
          act(5, "resolve_block", child, {
            blockerId: blocker,
            note: "Member cannot close manager blocker",
          }),
        );
        await act(4, "resolve_block", child, {
          blockerId: blocker,
          note: "Equipment found",
        });
        await act(5, "submit", child);
        await denied(
          act(5, "verify", child, { memberId: access.accounts[5].memberId }),
        );
        await act(0, "verify", child, {
          memberId: access.accounts[5].memberId,
        });
        await act(4, "complete", child);
        await act(2, "complete", parent);
      } finally {
        for (const row of saved)
          await owner.query("UPDATE memberships SET status=$2 WHERE id=$1", [
            row.id,
            row.status,
          ]);
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
          [added],
        );
      }
    },
  );
  await check(
    "revoked membership and moved ancestry hide historical work without leaking notifications",
    async () => {
      const task = (await command(2, "create", fresh())).id;
      const saved = (
        await owner.query(
          "SELECT id,status FROM memberships WHERE organization_id=$1 AND user_id=$2",
          [org, access.accounts[3].memberId],
        )
      ).rows;
      try {
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE organization_id=$1 AND user_id=$2",
          [org, access.accounts[3].memberId],
        );
        await denied(detail(3, task));
        assert.equal((await command(3, "list", { view: "inbox" })).total, 0);
        await denied(
          act(0, "assign", task, { memberId: access.accounts[3].memberId }),
        );
      } finally {
        for (const row of saved)
          await owner.query("UPDATE memberships SET status=$2 WHERE id=$1", [
            row.id,
            row.status,
          ]);
      }
      const group = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 ORDER BY id LIMIT 1",
          [org, a],
        )
      ).rows[0].id;
      const moved = (await command(2, "create", fresh(group))).id;
      try {
        await owner.query(
          "UPDATE units SET parent_id=$1 WHERE organization_id=$2 AND id=$3",
          [b, org, group],
        );
        await denied(detail(2, moved));
        await denied(detail(4, moved));
        assert.ok(
          !(await command(0, "list")).items.some((x: any) => x.id === moved),
        );
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$1 WHERE organization_id=$2 AND id=$3",
          [a, org, group],
        );
      }
    },
  );
  await check(
    "verification audit failure cannot emit Activity or completion notifications",
    async () => {
      const task = (await command(2, "create", fresh())).id;
      await act(2, "apply", task);
      await act(3, "assign", task, { memberId: access.accounts[2].memberId });
      await act(2, "start", task);
      await act(2, "submit", task);
      const before = (await detail(3, task)).version;
      const input = {
        id: task,
        key: randomUUID(),
        version: before,
        memberId: access.accounts[2].memberId,
      };
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic verification audit failure");
      };
      try {
        await assert.rejects(
          command(0, "verify", input),
          /Synthetic verification audit failure/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      const d = await detail(3, task);
      assert.equal(d.version, before);
      assert.equal(d.assignments[0].status, "submitted");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM activity_entries e JOIN work_assignments a ON a.organization_id=e.organization_id AND a.id=e.assignment_id WHERE a.work_id=$1",
            [task],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM work_notifications WHERE work_id=$1 AND version>$2",
            [task, before],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  if (process.argv.includes("--browser")) {
    const { verifyWorkBrowser } = await import("./work-browser");
    await verifyWorkBrowser(app, access);
    checks++;
  }
  const { testWorkOversight } = await import("./work-oversight-tests");
  await testWorkOversight({
    command,
    act,
    detail,
    owner,
    access,
    check,
    denied,
  });
  const { testWorkNeeds } = await import("./work-needs-tests");
  const renewStepUp = async () => {
    for (const s of sessions)
      await s.agent
        .post(base + "/demo/step-up")
        .set("Origin", origin)
        .set("X-Admin-Csrf", s.csrf)
        .send({})
        .expect(200);
  };
  await renewStepUp();
  await testWorkNeeds({ command, act, detail, owner, access, check, denied });
  const { collectiveCommand } =
    await import("../backend/src/modules/governance/collective");
  const { testCollective } = await import("./collective-tests");
  await renewStepUp();
  const collective = (
    i: number,
    op: Parameters<typeof collectiveCommand>[1],
    input: object = {},
  ) =>
    collectiveCommand(
      sessions[i],
      op,
      ["contexts", "point_contexts"].includes(op)
        ? input
        : { organizationId: org, ...input },
    );
  await testCollective({
    command,
    act,
    detail,
    owner,
    access,
    check,
    denied,
    collective,
  });
  const { decisionCommand } =
    await import("../backend/src/modules/decisions/polls");
  const decision = (
    i: number,
    op: Parameters<typeof decisionCommand>[1],
    input: object = {},
  ) =>
    decisionCommand(
      sessions[i],
      op,
      op === "contexts" ? input : { organizationId: org, ...input },
    );
  const { testContribution } = await import("./contribution-tests");
  await renewStepUp();
  await testContribution({
    command,
    act,
    detail,
    owner,
    access,
    check,
    denied,
    collective,
    decision,
  });
  const { testMobilization } = await import('./mobilization-tests');
  await renewStepUp();
  await testMobilization({command,act,detail,owner,access,check,denied,collective});
  const { testWorkMaterials } = await import('./work-materials-tests');
  await testWorkMaterials({command,act,detail,owner,access,check,denied});
  await check(
    "collective HTTP routes enforce sessions, CSRF and strict schemas",
    async () => {
      await request(app)
        .get(base + "/collective/contexts")
        .expect(401);
      await sessions[2].agent.get(base + "/collective/contexts").expect(200);
      await sessions[2].agent
        .post(base + "/collective/propose")
        .set("Origin", origin)
        .send({})
        .expect(403);
      await sessions[2].agent
        .post(base + "/collective/propose")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send({ organizationId: org, role: "super_admin" })
        .expect(400);
    },
  );
  if (process.argv.includes("--oversight-browser")) {
    const { verifyWorkOversightBrowser } =
      await import("./work-oversight-browser");
    await verifyWorkOversightBrowser(app, access);
    checks++;
  }
  if (process.argv.includes("--operations-browser")) {
    const { verifyOperationsBrowser } = await import("./operations-browser");
    await verifyOperationsBrowser(app, access);
    checks++;
  }
  console.log(`${checks} Work integration scenarios passed`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
