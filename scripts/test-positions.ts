import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_positions_${randomBytes(8).toString("hex")}`,
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
      stdio: "inherit",
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
  const { enableDemoMembers } = await import("./web-demo-members");
  await enableDemoMembers(owner, access);
  const { enableDemoPositions } = await import("./web-demo-positions");
  await enableDemoPositions(owner, access);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { collectiveCommand } =
    await import("../backend/src/modules/governance/collective");
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
    op: Parameters<typeof collectiveCommand>[1],
    input: object = {},
  ) => collectiveCommand(sessions[i], op, { organizationId: org, ...input });
  const denied = (p: Promise<unknown>, status = 403) =>
    assert.rejects(
      p,
      (e: unknown) => (e as { statusCode: number }).statusCode === status,
    );
  const payload = (
    name = `Synthetic position ${randomUUID()}`,
    extra = {},
  ) => ({
    key: randomUUID(),
    unitId: a,
    kind: "position_create",
    reason: "Synthetic permission definition",
    deadline: new Date(Date.now() + 86400000).toISOString(),
    parameters: {
      name,
      grants: [{ permission: "unit.read", scope: "unit" }],
      ...extra,
    },
  });
  const vote = (id: string, version = 1) => ({
    id,
    version,
    key: randomUUID(),
    choice: "approve",
    reason: "Reviewed synthetic permissions",
  });
  const count = async (table: string) =>
    (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
  let original = "";
  await check("catalogue defers editor grants without changing scoped positions or available units", async () => {
    const full = await command(2, "positions", { includeGrants: "true" });
    const list = await command(2, "positions", { includeGrants: "false" });
    assert.deepEqual(list.items, full.items);
    assert.deepEqual(list.units, full.units.map((u: { grants: unknown[] }) => ({ ...u, grants: [] })));
    assert.ok(full.units.some((u: { grants: unknown[] }) => u.grants.length > 0));
    await denied(command(2, "positions", { unitId: b, includeGrants: "true" }));
    await denied(command(2, "positions", { includeGrants: "invalid" }), 400);
  });
  await check(
    "scoped catalogue and explicit administration permissions",
    async () => {
      assert.equal(
        (await collectiveCommand(sessions[0], "position_contexts", {})).length,
        1,
      );
      const list = await command(2, "positions");
      assert.ok(list.units.length > 0);
      assert.ok(list.units.every((u: { id: string }) => u.id !== b));
      await denied(command(2, "positions", { unitId: b }));
      await denied(command(0, "positions", { organizationId: randomUUID() }));
      await denied(command(0, "positions", { page: 0 }), 400);
    },
  );
  await check(
    "independent approval creates a definition without appointing anyone; exact concurrent retries",
    async () => {
      const before = await count("memberships"),
        input = payload();
      const p = await command(0, "propose", input);
      original = p.id;
      assert.equal(
        (await owner.query("SELECT 1 FROM positions WHERE id=$1", [p.id]))
          .rowCount,
        0,
      );
      await denied(command(0, "vote", vote(p.id)));
      await denied(command(4, "vote", vote(p.id)));
      const approval = vote(p.id);
      const results = await Promise.all([
        command(1, "vote", approval),
        command(1, "vote", approval),
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.deepEqual(await command(0, "propose", input), p);
      await denied(
        command(0, "propose", { ...input, reason: "Changed retry" }),
        409,
      );
      assert.equal(await count("memberships"), before);
      assert.equal(
        (await owner.query("SELECT status FROM positions WHERE id=$1", [p.id]))
          .rows[0].status,
        "active",
      );
      const item = (
        await command(0, "positions", { search: input.parameters.name })
      ).items[0];
      assert.deepEqual(item.grants, input.parameters.grants);
      assert.equal(item.canRevise, true);
      await denied(command(0, "propose", payload(input.parameters.name)), 409);
    },
  );
  await check(
    "unknown, administrative, duplicate and missing visibility grants are rejected",
    async () => {
      for (const grants of [
        [{ permission: "platform.manage", scope: "unit" }],
        [
          { permission: "unit.read", scope: "unit" },
          { permission: "position.propose", scope: "subtree" },
        ],
        [
          { permission: "unit.read", scope: "unit" },
          { permission: "unit.read", scope: "subtree" },
        ],
        [{ permission: "member.read", scope: "unit" }],
      ])
        await denied(
          command(0, "propose", payload(undefined, { grants })),
          400,
        );
      await denied(
        command(0, "propose", { ...payload(), workId: randomUUID() }),
        400,
      );
      await denied(command(2, "propose", { ...payload(), unitId: b }));
    },
  );
  await check(
    "unit-only permission cannot become a subtree permission",
    async () => {
      const bundle = randomUUID(),
        position = randomUUID();
      await owner.query(
        "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO permission_grants VALUES($1,$2,1,'workitem.create','unit')",
        [org, bundle],
      );
      await owner.query(
        "UPDATE permission_bundles SET status='approved' WHERE id=$1",
        [bundle],
      );
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic unit-only authority',$4,1)",
        [org, position, a, bundle],
      );
      for (const i of [0, 1])
        await owner.query(
          "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
          [org, access.accounts[i].memberId, a, position],
        );
      const grants = [
        { permission: "unit.read", scope: "unit" },
        { permission: "workitem.create", scope: "subtree" },
      ];
      await denied(command(0, "propose", payload(undefined, { grants })));
      grants[1].scope = "unit";
      const p = await command(0, "propose", payload(undefined, { grants }));
      await command(1, "vote", vote(p.id));
      assert.equal(
        (await command(0, "detail", { id: p.id })).status,
        "approved",
      );
    },
  );
  await check(
    "new revision preserves existing membership and frozen grants; competing revision is stale",
    async () => {
      const user = randomUUID();
      await owner.query("INSERT INTO member_users(id) VALUES($1)", [user]);
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
        [org, user, a, original],
      );
      const before = (
        await owner.query(
          "SELECT to_jsonb(m) data FROM memberships m WHERE user_id=$1",
          [user],
        )
      ).rows;
      const r1 = {
        ...payload(undefined, { sourceId: original, sourceVersion: 0 }),
        kind: "position_revision",
      };
      const r2 = {
        ...payload(undefined, { sourceId: original, sourceVersion: 0 }),
        kind: "position_revision",
      };
      const p1 = await command(0, "propose", r1),
        p2 = await command(0, "propose", r2);
      await command(1, "vote", vote(p1.id));
      await denied(command(1, "vote", vote(p2.id)), 409);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT to_jsonb(m) data FROM memberships m WHERE user_id=$1",
            [user],
          )
        ).rows,
        before,
      );
      const row = (
        await owner.query("SELECT * FROM positions WHERE id=$1", [p1.id])
      ).rows[0];
      assert.equal(row.predecessor_id, original);
      assert.equal(row.revision, 2);
      assert.equal(
        (
          await owner.query("SELECT status FROM positions WHERE id=$1", [
            original,
          ])
        ).rows[0].status,
        "active",
      );
      assert.equal(
        (await command(0, "positions", { search: r1.parameters.name })).items[0]
          .canRevise,
        true,
      );
    },
  );
  await check(
    "changed source and expired requests cannot be approved",
    async () => {
      const p = await command(0, "propose", payload());
      await command(1, "vote", vote(p.id));
      const rev = await command(0, "propose", {
        ...payload(undefined, { sourceId: p.id, sourceVersion: 0 }),
        kind: "position_revision",
      });
      await owner.query(
        "UPDATE positions SET name='Changed source position' WHERE id=$1",
        [p.id],
      );
      await denied(command(1, "vote", vote(rev.id)), 409);
      await denied(
        command(0, "propose", {
          ...payload(),
          deadline: new Date(Date.now() - 1000).toISOString(),
        }),
        400,
      );
    },
  );
  await check(
    "current proposer and reviewer authority remains required",
    async () => {
      const p = await command(0, "propose", payload());
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE user_id=$1",
        [access.accounts[0].memberId],
      );
      await denied(command(1, "vote", vote(p.id)));
      await owner.query(
        "UPDATE memberships SET status='active' WHERE user_id=$1",
        [access.accounts[0].memberId],
      );
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE user_id=$1",
        [access.accounts[1].memberId],
      );
      await denied(command(1, "vote", vote(p.id)));
      await owner.query(
        "UPDATE memberships SET status='active' WHERE user_id=$1",
        [access.accounts[1].memberId],
      );
      await command(1, "vote", vote(p.id));
    },
  );
  await check(
    "audit failure and post-audit definition tampering roll back approval",
    async () => {
      const p = await command(0, "propose", payload()),
        counts = await count("permission_bundles");
      await owner.query(
        "CREATE FUNCTION fail_position_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='COLLECTIVE_COMMAND' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_position_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_position_audit()",
      );
      await assert.rejects(command(1, "vote", vote(p.id)));
      await owner.query(
        "DROP TRIGGER fail_position_audit ON audit_log; DROP FUNCTION fail_position_audit()",
      );
      await owner.query(
        `CREATE FUNCTION tamper_position_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='COLLECTIVE_COMMAND' THEN UPDATE ertad.positions SET name='Synthetic tampered position' WHERE id='${p.id}'::uuid; END IF; RETURN NEW; END $$; CREATE TRIGGER tamper_position_audit AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION tamper_position_audit()`,
      );
      await denied(command(1, "vote", vote(p.id)), 409);
      await owner.query(
        "DROP TRIGGER tamper_position_audit ON audit_log; DROP FUNCTION tamper_position_audit()",
      );
      assert.equal(await count("permission_bundles"), counts);
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM collective_proposals WHERE id=$1",
            [p.id],
          )
        ).rows[0].status,
        "pending",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT 1 FROM collective_votes WHERE proposal_id=$1",
            [p.id],
          )
        ).rowCount,
        0,
      );
      await command(1, "vote", vote(p.id));
    },
  );
  await check(
    "losing a required delegated permission during audit invalidates the approving vote",
    async () => {
      const p = await command(
        0,
        "propose",
        payload(undefined, {
          grants: [
            { permission: "unit.read", scope: "unit" },
            { permission: "workitem.create", scope: "unit" },
          ],
        }),
      );
      const reviewer = access.accounts[1].memberId;
      await owner.query(
        `CREATE FUNCTION revoke_position_permission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='COLLECTIVE_COMMAND' THEN UPDATE ertad.memberships SET status='suspended' WHERE user_id='${reviewer}'::uuid AND position_id IN (SELECT id FROM ertad.positions WHERE name='Synthetic unit-only authority'); END IF; RETURN NEW; END $$; CREATE TRIGGER revoke_position_permission AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION revoke_position_permission()`,
      );
      await denied(command(1, "vote", vote(p.id)));
      await owner.query(
        "DROP TRIGGER revoke_position_permission ON audit_log; DROP FUNCTION revoke_position_permission()",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM collective_proposals WHERE id=$1",
            [p.id],
          )
        ).rows[0].status,
        "pending",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*) FROM collective_votes WHERE proposal_id=$1",
            [p.id],
          )
        ).rows[0].count,
        "0",
      );
      await command(1, "vote", vote(p.id));
    },
  );
  const { testPositionRetirement } =
    await import("./position-retirement-tests");
  const retirementBrowserId = await testPositionRetirement(
    owner,
    access,
    sessions,
    command,
    check,
  );
  await check(
    "HTTP CSRF/step-up and direct runtime writes remain denied",
    async () => {
      const retirement = {
        organizationId: org,
        key: randomUUID(),
        unitId: a,
        kind: "position_retire",
        reason: "HTTP retirement boundary check",
        deadline: new Date(Date.now() + 86400000).toISOString(),
        parameters: {
          sourceId: retirementBrowserId,
          sourceVersion: 0,
          sourceName: "Retirement browser position",
        },
      };
      await sessions[0].agent
        .post(base + "/collective/propose")
        .set("Origin", origin)
        .send(retirement)
        .expect(403);
      await sessions[0].agent
        .post(base + "/collective/propose")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[0].csrf)
        .send({
          ...retirement,
          parameters: { ...retirement.parameters, force: true },
        })
        .expect(400);
      await sessions[0].agent
        .post(base + "/collective/propose")
        .set("Origin", origin)
        .send({ organizationId: org, ...payload() })
        .expect(403);
      await sessions[0].agent
        .get(base + "/collective/positions")
        .query({ organizationId: org })
        .expect(200);
      await owner.query(
        "UPDATE admin_sessions SET step_up_expires_at=now()-interval '1 second' WHERE id=$1",
        [sessions[0].sessionId],
      );
      await denied(command(0, "propose", payload()), 428);
      const runtime = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await runtime.connect();
      try {
        await assert.rejects(
          runtime.query(
            "UPDATE ertad.positions SET name='Forbidden direct write'",
          ),
        );
        await assert.rejects(
          runtime.query(
            "SELECT ertad.position_retirement_validate($1,$2,$3,false)",
            [org, a, retirement.parameters],
          ),
        );
        await assert.rejects(
          runtime.query("SELECT ertad.position_retirement_blocked($1,$2)", [
            org,
            retirementBrowserId,
          ]),
        );
        await assert.rejects(
          runtime.query(
            "SELECT ertad.collective_before_recognition_command($1,$2,'propose',$3,$4)",
            [
              sessions[0].sessionId,
              sessions[0].sessionTokenHash,
              org,
              payload(),
            ],
          ),
        );
      } finally {
        await runtime.end();
      }
    },
  );
  if (process.argv.includes("--browser")) {
    const { runPositionsBrowser } = await import("./positions-browser");
    await runPositionsBrowser(app, access);
    const rows = (
      await owner.query(
        "SELECT name,revision,predecessor_id FROM positions WHERE name IN ('Browser position A','Browser position B') ORDER BY revision",
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].revision, 1);
    assert.equal(rows[1].revision, 2);
    assert.ok(rows[1].predecessor_id);
    console.log(
      "PASS browser definitions persisted with a distinct reviewed successor",
    );
  }
  if (process.argv.includes("--retirement-browser")) {
    const before = (
      await owner.query(
        "SELECT to_jsonb(m) data FROM memberships m ORDER BY organization_id,id",
      )
    ).rows;
    const { runPositionRetirementBrowser } =
      await import("./position-retirement-browser");
    await runPositionRetirementBrowser(app, access);
    assert.deepEqual(
      (
        await owner.query("SELECT status,version FROM positions WHERE id=$1", [
          retirementBrowserId,
        ])
      ).rows,
      [{ status: "retired", version: 1 }],
    );
    assert.deepEqual(
      (
        await owner.query(
          "SELECT to_jsonb(m) data FROM memberships m ORDER BY organization_id,id",
        )
      ).rows,
      before,
    );
    console.log(
      "PASS browser retirement persisted without changing memberships",
    );
  }
  console.log(
    `PASS ${checks} position definition scenarios; isolated database only`,
  );
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
