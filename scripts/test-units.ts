import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_units_test_${randomBytes(8).toString("hex")}`,
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
    { enableDemoHierarchy } = await import("./web-demo-hierarchy");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { unitCommand } =
    await import("../backend/src/modules/organization/units");
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
    op: Parameters<typeof unitCommand>[1],
    input: object = {},
  ) =>
    unitCommand(
      sessions[i],
      op,
      op === "contexts" ? input : { organizationId: org, ...input },
    );
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
  const fresh = (parentId = a) => ({
    key: randomUUID(),
    parentId,
    name: `Synthetic group ${randomUUID().slice(0, 8)}`,
    reason: "Synthetic operational reason",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const decide = (id: string) => ({
    id,
    key: randomUUID(),
    decision: "approved",
    reason: "Synthetic independent decision",
  });
  const count = async (table: string) =>
    Number((await owner.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  await check(
    "existing administrator grants cannot create hierarchy before explicit upgrade",
    async () => {
      assert.equal((await command(2, "units")).total, 2);
      await denied(command(2, "propose", fresh()));
      await owner.query("BEGIN");
      await enableDemoHierarchy(owner, access);
      await owner.query("COMMIT");
      const before = await count("memberships");
      await owner.query("BEGIN");
      await enableDemoHierarchy(owner, access);
      await owner.query("COMMIT");
      assert.equal(await count("memberships"), before);
    },
  );
  if (process.argv.includes("--browser")) {
    if (process.argv.includes("--lifecycle")) {
      const { enableDemoUnitChanges } = await import("./web-demo-unit-changes");
      await owner.query("BEGIN");
      await enableDemoUnitChanges(owner, access);
      const target = (
        await owner.query(
          "INSERT INTO units(organization_id,parent_id,name,kind) VALUES($1,$2,'Synthetic lifecycle browser group','authority') RETURNING id,name",
          [org, a],
        )
      ).rows[0];
      await owner.query("COMMIT");
      const { runUnitLifecycleBrowser } =
        await import("./unit-lifecycle-browser");
      await runUnitLifecycleBrowser(app, access, target.name);
      const stored = (
        await owner.query("SELECT status,version FROM units WHERE id=$1", [
          target.id,
        ])
      ).rows[0];
      assert.equal(stored.status, "active");
      assert.equal(stored.version, 3);
    } else {
      const { runUnitsBrowser } = await import("./units-browser");
      await runUnitsBrowser(app, access);
    }
    checks++;
  } else {
    await check(
      "six accounts see only allowed units, search counts and scoped parent references",
      async () => {
        for (let i = 0; i < 6; i++)
          assert.equal((await command(i, "units")).total, i < 2 ? 5 : 2);
        const own = (await command(2, "units")).items.find(
          (u: any) => u.id === a,
        );
        assert.equal(own.parent_id, null);
        assert.equal(own.canPropose, true);
        assert.equal(
          (await command(2, "units", { search: "missing synthetic name" }))
            .total,
          0,
        );
        await denied(command(2, "propose", fresh(b)));
        await denied(
          command(2, "propose", { ...fresh(), organizationId: randomUUID() }),
        );
      },
    );
    const payload = fresh();
    let review: any;
    await check(
      "immutable proposal and identical retries never create a unit or membership",
      async () => {
        review = await command(2, "propose", payload);
        assert.equal(review.status, "pending");
        assert.equal(await count("units"), 5);
        assert.deepEqual(await command(2, "propose", payload), review);
        await denied(
          command(2, "propose", { ...payload, name: "Changed payload" }),
          409,
        );
        assert.equal((await command(2, "list")).total, 0);
        assert.equal((await command(3, "list")).total, 1);
        assert.equal((await command(4, "list")).total, 0);
        await denied(command(4, "detail", { id: review.id }));
        await denied(command(2, "decide", decide(review.id)));
        await assert.rejects(
          owner.query("UPDATE unit_reviews SET name=$1 WHERE id=$2", [
            "Tampered",
            review.id,
          ]),
        );
      },
    );
    await check(
      "Origin, CSRF, unauthenticated access and strict input validation",
      async () => {
        await request(app)
          .get(base + "/units/contexts")
          .expect(401);
        await sessions[3].agent
          .post(base + "/units/decision")
          .send({ organizationId: org, ...decide(review.id) })
          .expect(403);
        await sessions[3].agent
          .post(base + "/units/decision")
          .set("Origin", origin)
          .send({ organizationId: org, ...decide(review.id) })
          .expect(403);
        await sessions[3].agent
          .post(base + "/units/decision")
          .set("Origin", origin)
          .set("X-Admin-Csrf", sessions[3].csrf)
          .send({
            organizationId: org,
            ...decide(review.id),
            actorId: access.accounts[0].memberId,
          })
          .expect(400);
        await denied(command(2, "propose", { ...fresh(), name: " " }), 400);
        await denied(
          command(2, "propose", {
            ...fresh(),
            expiresAt: new Date(Date.now() + 9 * 86400_000).toISOString(),
          }),
          400,
        );
      },
    );
    await check(
      "runtime cannot directly modify units, reviews or published permission grants",
      async () => {
        await assert.rejects(
          db.query(
            "INSERT INTO ertad.units(organization_id,parent_id,name,kind) VALUES($1,$2,'Bypass','authority')",
            [org, a],
          ),
          (e: any) => e.code === "42501",
        );
        await assert.rejects(
          db.query(
            "UPDATE ertad.unit_reviews SET status='approved' WHERE id=$1",
            [review.id],
          ),
          (e: any) => e.code === "42501",
        );
        await assert.rejects(
          db.query("UPDATE ertad.permission_grants SET permission=$1", [
            "unit.approve",
          ]),
          (e: any) => e.code === "42501",
        );
      },
    );
    await check(
      "expired step-up and revoked sessions fail before mutation",
      async () => {
        await owner.query(
          "UPDATE admin_sessions SET step_up_expires_at=NULL WHERE id=$1",
          [sessions[3].sessionId],
        );
        await denied(command(3, "decide", decide(review.id)), 428);
        await owner.query(
          "UPDATE admin_sessions SET step_up_expires_at=now()+interval '20 minutes',revoked_at=now() WHERE id=$1",
          [sessions[3].sessionId],
        );
        await denied(command(3, "units"));
        await owner.query(
          "UPDATE admin_sessions SET revoked_at=NULL WHERE id=$1",
          [sessions[3].sessionId],
        );
      },
    );
    await check(
      "requester revocation and archived parent invalidate approval",
      async () => {
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE user_id=$1",
          [access.accounts[2].memberId],
        );
        await denied(command(3, "decide", decide(review.id)), 409);
        await owner.query(
          "UPDATE memberships SET status='active' WHERE user_id=$1",
          [access.accounts[2].memberId],
        );
        await owner.query("UPDATE units SET status='archived' WHERE id=$1", [
          a,
        ]);
        await denied(command(3, "decide", decide(review.id)));
        await owner.query("UPDATE units SET status='active' WHERE id=$1", [a]);
      },
    );
    await check(
      "audit failure rolls back unit creation and decision together",
      async () => {
        await owner.query(`CREATE FUNCTION reject_unit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='UNIT_REVIEW' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_unit_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_unit_audit()`);
        await assert.rejects(command(3, "decide", decide(review.id)));
        assert.equal(await count("units"), 5);
        assert.equal(
          (
            await owner.query("SELECT status FROM unit_reviews WHERE id=$1", [
              review.id,
            ])
          ).rows[0].status,
          "pending",
        );
        await owner.query(
          "DROP TRIGGER reject_unit_audit ON audit_log; DROP FUNCTION reject_unit_audit()",
        );
      },
    );
    await check(
      "concurrent retries create exactly one unit and no new position or membership",
      async () => {
        const decision = decide(review.id),
          members = await count("memberships"),
          positions = await count("positions");
        const results = await Promise.all([
          command(3, "decide", decision),
          command(3, "decide", decision),
        ]);
        assert.deepEqual(results[0], results[1]);
        assert.equal(results[0].status, "approved");
        assert.equal(await count("units"), 6);
        assert.equal(await count("memberships"), members);
        assert.equal(await count("positions"), positions);
        await denied(
          command(3, "decide", { ...decision, decision: "rejected" }),
          409,
        );
        assert.equal((await command(4, "units")).total, 2);
        assert.equal((await command(2, "units")).total, 3);
      },
    );
    await check(
      "duplicate active sibling names cannot create a second unit",
      async () => {
        const r = await command(2, "propose", {
          ...fresh(),
          name: payload.name.toUpperCase(),
        });
        await denied(command(3, "decide", decide(r.id)), 409);
        assert.equal(await count("units"), 6);
        await command(3, "decide", { ...decide(r.id), decision: "rejected" });
        assert.equal(await count("units"), 6);
      },
    );
    await check(
      "ancestor drift invalidates a reviewed proposal even for root-scoped reviewers",
      async () => {
        const group = (
          await owner.query(
            "SELECT id FROM units WHERE parent_id=$1 ORDER BY id LIMIT 1",
            [a],
          )
        ).rows[0].id;
        const r = await command(0, "propose", fresh(group));
        await owner.query("UPDATE units SET parent_id=$1 WHERE id=$2", [
          b,
          group,
        ]);
        await denied(command(1, "decide", decide(r.id)), 409);
        await owner.query("UPDATE units SET parent_id=$1 WHERE id=$2", [
          a,
          group,
        ]);
      },
    );
    await check(
      "authority expiry during audit rolls back an otherwise valid proposal",
      async () => {
        const n = await count("unit_reviews");
        await owner.query(`CREATE FUNCTION delay_unit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='UNIT_REVIEW' THEN PERFORM pg_sleep(0.3); END IF; RETURN NEW; END $$;
      CREATE TRIGGER delay_unit_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION delay_unit_audit()`);
        await owner.query(
          "UPDATE memberships SET valid_until=clock_timestamp()+interval '150 milliseconds' WHERE user_id=$1",
          [access.accounts[2].memberId],
        );
        await assert.rejects(command(2, "propose", fresh()));
        assert.equal(await count("unit_reviews"), n);
        await owner.query(
          "DROP TRIGGER delay_unit_audit ON audit_log; DROP FUNCTION delay_unit_audit()",
        );
        await owner.query(
          "UPDATE memberships SET valid_until=now()+interval '90 days' WHERE user_id=$1",
          [access.accounts[2].memberId],
        );
      },
    );
    await check("request expiry during audit is rolled back", async () => {
      await owner.query(`CREATE FUNCTION delay_unit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='UNIT_REVIEW' THEN PERFORM pg_sleep(0.3); END IF; RETURN NEW; END $$;
      CREATE TRIGGER delay_unit_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION delay_unit_audit()`);
      const n = await count("unit_reviews");
      await assert.rejects(
        command(2, "propose", {
          ...fresh(),
          expiresAt: new Date(Date.now() + 150).toISOString(),
        }),
      );
      assert.equal(await count("unit_reviews"), n);
      await owner.query(
        "DROP TRIGGER delay_unit_audit ON audit_log; DROP FUNCTION delay_unit_audit()",
      );
    });
    await check(
      "expired requests leave pending and appear consistently in history and detail",
      async () => {
        const id = randomUUID();
        await owner.query(
          `INSERT INTO unit_reviews(organization_id,id,parent_id,parent_path,name,requester_id,reason,request_key,created_at,expires_at)
      VALUES($1,$2,$3,ertad.unit_path($1,$3),'Expired synthetic group',$4,'Synthetic expiry scenario',$5,now()-interval '2 days',now()-interval '1 day')`,
          [org, id, a, access.accounts[2].memberId, randomUUID()],
        );
        assert.equal((await command(3, "detail", { id })).status, "expired");
        assert.equal((await command(3, "detail", { id })).canDecide, false);
        assert.ok(
          !(await command(3, "list")).items.some((r: any) => r.id === id),
        );
        assert.ok(
          (await command(3, "list", { view: "history" })).items.some(
            (r: any) => r.id === id,
          ),
        );
        await denied(command(3, "decide", decide(id)), 409);
      },
    );
  }
  if (!process.argv.includes("--browser")) {
    const { testUnitLifecycle } = await import("./unit-lifecycle-tests");
    checks += await testUnitLifecycle(owner, access, sessions);
    const { testUnitTerritories } = await import("./unit-territory-tests");
    checks += await testUnitTerritories(owner, access, sessions);
  }
  console.log(`PASS ${checks} hierarchy scenarios; disposable database only`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
