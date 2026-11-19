import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_membership_lifecycle_${randomBytes(8).toString("hex")}`,
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
const browserOnly = process.argv.includes("--browser-only");
if (browserOnly && !process.argv.includes("--rollout-browser"))
  throw new Error("Browser-only mode requires the rollout browser journey");
async function check(name: string, fn: () => Promise<void>) {
  if (browserOnly) return;
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
  const { enableDemoMembers } = await import("./web-demo-members");
  await enableDemoMembers(owner, access);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { reviewCommand } =
    await import("../backend/src/modules/governance/reviews");
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
    op: Parameters<typeof reviewCommand>[1],
    input: object = {},
  ) => reviewCommand(sessions[i], op, { organizationId: org, ...input });
  const denied = (p: Promise<unknown>, status = 403) =>
    assert.rejects(
      p,
      (e: unknown) => (e as { statusCode: number }).statusCode === status,
    );
  const decide = (id: string, decision = "approved") => ({
    id,
    key: randomUUID(),
    decision,
    reason: "Synthetic independent membership decision",
  });
  const observer = (
    await owner.query(
      "SELECT b.id FROM permission_bundles b WHERE b.organization_id=$1 AND NOT EXISTS(SELECT 1 FROM permission_grants g WHERE g.organization_id=b.organization_id AND g.bundle_id=b.id AND g.permission<>'unit.read') LIMIT 1",
      [org],
    )
  ).rows[0].id;
  async function fixture() {
    const user = randomUUID(),
      source = randomUUID(),
      dest = randomUUID();
    await owner.query("INSERT INTO member_users(id) VALUES($1)", [user]);
    await owner.query(
      "INSERT INTO organization_member_labels VALUES($1,$2,'Synthetic lifecycle member')",
      [org, user],
    );
    for (const [id, unit, name] of [
      [source, a, "Synthetic source role"],
      [dest, b, "Synthetic destination role"],
    ])
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,$4,$5,1)",
        [org, id, unit, name, observer],
      );
    const m = (
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now()-interval '1 day',now()+interval '30 days') RETURNING *",
        [org, user, a, source],
      )
    ).rows[0];
    return { user, source, dest, m };
  }
  const change = (
    f: Awaited<ReturnType<typeof fixture>>,
    kind = "transfer",
  ) => ({
    key: randomUUID(),
    membershipId: f.m.id,
    version: f.m.version,
    kind,
    reason: "Synthetic membership lifecycle reason",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    ...(kind === "transfer"
      ? {
          positionId: f.dest,
          validUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
        }
      : {}),
  });
  await check(
    "source discovery and cross-region transfer require both scopes; self and foreign identities denied",
    async () => {
      const f = await fixture(),
        opts = await command(2, "changeOptions", { membershipId: f.m.id });
      assert.equal(opts.version, 0);
      assert.ok(
        !opts.destinations.some((p: { id: string }) => p.id === f.dest),
      );
      await denied(command(2, "change", change(f)));
      await denied(command(4, "changeOptions", { membershipId: f.m.id }));
      await denied(
        command(0, "changeOptions", {
          membershipId: f.m.id,
          organizationId: randomUUID(),
        }),
      );
      const self = (
        await owner.query(
          "SELECT id FROM memberships WHERE organization_id=$1 AND user_id=$2 LIMIT 1",
          [org, access.accounts[2].memberId],
        )
      ).rows[0].id;
      await denied(command(2, "changeOptions", { membershipId: self }));
    },
  );
  await check(
    "transfer freezes source, hides snapshots, requires independence, retries exactly and applies once",
    async () => {
      const f = await fixture(),
        payload = change(f),
        r = await command(0, "change", payload);
      assert.deepEqual(await command(0, "change", payload), r);
      await denied(
        command(0, "change", {
          ...payload,
          reason: "Different synthetic reason",
        }),
        409,
      );
      await denied(
        command(0, "propose", {
          key: payload.key,
          targetId: f.user,
          positionId: f.dest,
          reason: payload.reason,
          expiresAt: payload.expiresAt,
          validUntil: payload.validUntil,
        }),
        409,
      );
      const detail = await command(1, "detail", { id: r.id });
      assert.equal(detail.kind, "transfer");
      assert.equal(detail.source_snapshot, undefined);
      assert.equal(detail.canDecide, true);
      await denied(command(2, "detail", { id: r.id }));
      await denied(command(0, "decide", decide(r.id)));
      await denied(command(3, "decide", decide(r.id)));
      const d = decide(r.id);
      await Promise.all([command(1, "decide", d), command(1, "decide", d)]);
      assert.equal(
        (
          await owner.query("SELECT status FROM memberships WHERE id=$1", [
            f.m.id,
          ])
        ).rows[0].status,
        "ended",
      );
      const rows = (
        await owner.query("SELECT * FROM memberships WHERE user_id=$1", [
          f.user,
        ])
      ).rows;
      assert.equal(rows.length, 2);
      assert.equal(
        rows.filter((m) => m.status === "active")[0].position_id,
        f.dest,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT ertad.review_has_scope($1,$2,$3,'unit.read') ok",
            [f.user, org, a],
          )
        ).rows[0].ok,
        false,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT ertad.review_has_scope($1,$2,$3,'unit.read') ok",
            [f.user, org, b],
          )
        ).rows[0].ok,
        true,
      );
      assert.deepEqual(await command(0, "change", payload), {
        id: r.id,
        status: "approved",
      });
      await denied(command(1, "decide", { ...d, decision: "rejected" }), 409);
    },
  );
  await check(
    "revocation ends only the selected membership and immediately removes its authority",
    async () => {
      const f = await fixture(),
        r = await command(2, "change", change(f, "revoke"));
      await command(3, "decide", decide(r.id));
      const m = (
        await owner.query("SELECT * FROM memberships WHERE id=$1", [f.m.id])
      ).rows[0];
      assert.equal(m.status, "ended");
      assert.equal(m.version, 1);
      assert.equal(m.user_id, f.user);
      assert.equal(
        (
          await owner.query("SELECT count(*) FROM member_users WHERE id=$1", [
            f.user,
          ])
        ).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT ertad.review_has_scope($1,$2,$3,'unit.read') ok",
            [f.user, org, a],
          )
        ).rows[0].ok,
        false,
      );
    },
  );
  await check(
    "stale source ABA, duplicate destination, expiry and excessive extension fail without partial mutation",
    async () => {
      const f = await fixture(),
        r = await command(0, "change", change(f));
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=$1",
        [f.m.id],
      );
      await owner.query("UPDATE memberships SET status='active' WHERE id=$1", [
        f.m.id,
      ]);
      await denied(command(1, "decide", decide(r.id)), 409);
      await command(1, "decide", decide(r.id, "rejected"));
      const g = await fixture();
      await denied(
        command(0, "change", {
          ...change(g),
          validUntil: new Date(Date.now() + 60 * 86400000).toISOString(),
        }),
        409,
      );
      const q = await command(0, "change", change(g));
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from) VALUES($1,$2,$3,$4,1,now())",
        [org, g.user, b, g.dest],
      );
      await denied(command(1, "decide", decide(q.id)), 409);
      await denied(
        command(0, "change", {
          ...change(g),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
        409,
      );
    },
  );
  async function work(
    f: Awaited<ReturnType<typeof fixture>>,
    status = "assigned",
  ) {
    const id = randomUUID();
    await owner.query(
      "INSERT INTO work_items(organization_id,id,unit_id,creator_id,title,description,role_label,priority,capacity,deadline,status,scope_path) VALUES($1,$2,$3,$4,'Synthetic responsibility','','Participant','normal',5,now()+interval '10 days','open',ertad.unit_path($1,$3))",
      [org, id, a, access.accounts[0].memberId],
    );
    await owner.query(
      "INSERT INTO work_assignments(organization_id,work_id,user_id,status) VALUES($1,$2,$3,$4)",
      [org, id, f.user, status],
    );
    return id;
  }
  await check(
    "ongoing work blocks proposal and newly attached work blocks approval; rejection remains possible",
    async () => {
      const f = await fixture();
      await work(f);
      assert.equal(
        (await command(2, "changeOptions", { membershipId: f.m.id })).blocked,
        true,
      );
      await denied(command(2, "change", change(f, "revoke")), 409);
      const g = await fixture(),
        r = await command(0, "change", change(g));
      await work(g);
      await denied(command(1, "decide", decide(r.id)), 409);
      await command(1, "decide", decide(r.id, "rejected"));
    },
  );
  await check(
    "completed work, Activity and earned points survive transfer and termination unchanged",
    async () => {
      const f = await fixture(),
        wid = await work(f, "verified");
      const before = (
        await owner.query(
          "SELECT to_jsonb(a) record FROM work_assignments a WHERE work_id=$1",
          [wid],
        )
      ).rows[0].record;
      const proposal = randomUUID(),
        rule = randomUUID(),
        activity = randomUUID();
      await owner.query(
        "INSERT INTO collective_proposals(organization_id,id,unit_id,kind,parameters,proposer_id,reason,scope_path,eligible_ids,threshold,policy_version,status,deadline) VALUES($1,$2,$3,'points_rule','{}',$4,'Synthetic completed reward',ertad.unit_path($1,$3),ARRAY[$5::uuid],1,1,'approved',now()+interval '1 day')",
        [
          org,
          proposal,
          a,
          access.accounts[0].memberId,
          access.accounts[1].memberId,
        ],
      );
      await owner.query(
        "INSERT INTO contribution_rules(organization_id,id,unit_id,category,version,enabled,amount,member_month_cap,issuer_month_cap,proposal_id) VALUES($1,$2,$3,'task',1,true,17,100,100,$4)",
        [org, rule, a, proposal],
      );
      await owner.query(
        "INSERT INTO activity_entries(organization_id,id,user_id,unit_id,assignment_id,kind,verifier_id,value) VALUES($1,$2,$3,$4,$5,'task_completed',$6,1)",
        [org, activity, f.user, a, before.id, access.accounts[1].memberId],
      );
      await owner.query(
        "INSERT INTO contribution_entries(organization_id,unit_id,user_id,kind,category,points,rule_id,source_kind,source_id) VALUES($1,$2,$3,'award','task',17,$4,'activity',$5)",
        [org, a, f.user, rule, activity],
      );
      const history = async () => ({
        activity: (
          await owner.query(
            "SELECT to_jsonb(e) record FROM activity_entries e WHERE user_id=$1",
            [f.user],
          )
        ).rows,
        points: (
          await owner.query(
            "SELECT to_jsonb(e) record FROM contribution_entries e WHERE user_id=$1",
            [f.user],
          )
        ).rows,
      });
      const preserved = await history();
      const r = await command(0, "change", change(f));
      await command(1, "decide", decide(r.id));
      assert.deepEqual(await history(), preserved);
      const transferred = (
        await owner.query(
          "SELECT * FROM memberships WHERE user_id=$1 AND status='active'",
          [f.user],
        )
      ).rows[0];
      const end = await command(0, "change", {
        ...change(f, "revoke"),
        membershipId: transferred.id,
        version: transferred.version,
      });
      await command(1, "decide", decide(end.id));
      assert.deepEqual(await history(), preserved);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT to_jsonb(a) record FROM work_assignments a WHERE work_id=$1",
            [wid],
          )
        ).rows[0].record,
        before,
      );
    },
  );
  await check(
    "audit failure rolls back the old/new membership and all notifications",
    async () => {
      const f = await fixture(),
        r = await command(0, "change", change(f));
      await owner.query(
        "CREATE FUNCTION fail_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='MEMBERSHIP_REVIEW' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_lifecycle_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_lifecycle_audit()",
      );
      await assert.rejects(command(1, "decide", decide(r.id)));
      await owner.query(
        "DROP TRIGGER fail_lifecycle_audit ON audit_log; DROP FUNCTION fail_lifecycle_audit()",
      );
      assert.equal(
        (
          await owner.query("SELECT status FROM memberships WHERE id=$1", [
            f.m.id,
          ])
        ).rows[0].status,
        "active",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*) FROM memberships WHERE user_id=$1",
            [f.user],
          )
        ).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*) FROM review_notifications WHERE review_id=$1",
            [r.id],
          )
        ).rows[0].count,
        "0",
      );
    },
  );
  await check(
    "loss of proposer authority and hierarchy drift invalidate pending changes",
    async () => {
      const f = await fixture(),
        r = await command(2, "change", change(f, "revoke"));
      const ids = (
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE user_id=$1 AND status='active' RETURNING id",
          [access.accounts[2].memberId],
        )
      ).rows.map((x) => x.id);
      await denied(command(3, "decide", decide(r.id)), 409);
      await owner.query(
        "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
        [ids],
      );
      const old = (
        await owner.query("SELECT parent_id FROM units WHERE id=$1", [b])
      ).rows[0].parent_id;
      const g = await fixture(),
        q = await command(0, "change", change(g));
      await owner.query("UPDATE units SET parent_id=$1 WHERE id=$2", [a, b]);
      await denied(command(1, "decide", decide(q.id)), 409);
      await owner.query("UPDATE units SET parent_id=$1 WHERE id=$2", [old, b]);
    },
  );
  await check(
    "HTTP changes require Origin, CSRF, strict fields and password confirmation",
    async () => {
      const f = await fixture(),
        body = { organizationId: org, ...change(f, "revoke") };
      await sessions[2].agent
        .post(base + "/reviews/changes")
        .send(body)
        .expect(403);
      await sessions[2].agent
        .post(base + "/reviews/changes")
        .set("Origin", origin)
        .send(body)
        .expect(403);
      const send = (data: object) =>
        sessions[2].agent
          .post(base + "/reviews/changes")
          .set("Origin", origin)
          .set("X-Admin-Csrf", sessions[2].csrf)
          .send(data);
      await send({ ...body, positionId: f.dest }).expect(400);
      await send({ ...body, unexpected: true }).expect(400);
      for (const kind of ["suspend", "resume"]) {
        await send({
          ...body,
          kind,
          validUntil: new Date(Date.now() + 86400000).toISOString(),
        }).expect(400);
        await send({ ...body, kind, positionId: f.dest }).expect(400);
      }
      await owner.query(
        "UPDATE admin_sessions SET step_up_expires_at=NULL WHERE id=$1",
        [sessions[2].sessionId],
      );
      await send(body).expect(428);
      await send({ ...body, kind: "suspend" }).expect(428);
      await sessions[2].agent
        .post(base + "/demo/step-up")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send({})
        .expect(200);
      const res = await send(body).expect(200);
      await send({ ...body, key: randomUUID(), kind: "suspend" }).expect(200);
      assert.match(res.headers["cache-control"], /no-store/);
      await assert.rejects(
        db.query("UPDATE ertad.memberships SET status=$1 WHERE id=$2", [
          "ended",
          f.m.id,
        ]),
      );
      await assert.rejects(
        db.query(
          "SELECT ertad.membership_pause_available(NULL::ertad.memberships,'resume')",
        ),
      );
    },
  );
  await check(
    "post-audit source tampering rolls back the complete transfer",
    async () => {
      const f = await fixture(),
        r = await command(0, "change", change(f));
      await owner.query(`CREATE FUNCTION tamper_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
      IF NEW.event_type='MEMBERSHIP_REVIEW' THEN UPDATE ertad.memberships SET status='suspended' WHERE id='${f.m.id}'::uuid; END IF; RETURN NEW; END $$;
      CREATE TRIGGER tamper_lifecycle_audit AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION tamper_lifecycle_audit()`);
      await denied(command(1, "decide", decide(r.id)), 409);
      await owner.query(
        "DROP TRIGGER tamper_lifecycle_audit ON audit_log; DROP FUNCTION tamper_lifecycle_audit()",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT status,version FROM memberships WHERE id=$1",
            [f.m.id],
          )
        ).rows[0].status,
        "active",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*) FROM memberships WHERE user_id=$1",
            [f.user],
          )
        ).rows[0].count,
        "1",
      );
    },
  );
  const { testMembershipSuspension } =
    await import("./membership-suspension-tests");
  await testMembershipSuspension({
    owner,
    access,
    command,
    fixture,
    work,
    check,
  });
  const { testPositionRollout } = await import("./position-rollout-tests");
  const rollout = await testPositionRollout({
    owner,
    access,
    command,
    fixture,
    work,
    check,
  });
  await check(
    "revision HTTP requires CSRF, strict unchanged-term input and step-up; private helpers remain denied",
    async () => {
      const f = await rollout.revision(),
        body = { organizationId: org, ...(await rollout.input(f)) };
      await sessions[0].agent
        .get(base + "/reviews/revision-options")
        .query({ organizationId: org, positionId: f.dest })
        .expect(200);
      await sessions[4].agent
        .get(base + "/reviews/revision-options")
        .query({ organizationId: org, positionId: f.dest })
        .expect(403);
      await sessions[0].agent
        .post(base + "/reviews/changes")
        .send(body)
        .expect(403);
      const send = (data: object) =>
        sessions[0].agent
          .post(base + "/reviews/changes")
          .set("Origin", origin)
          .set("X-Admin-Csrf", sessions[0].csrf)
          .send(data);
      await send({
        ...body,
        validUntil: new Date(Date.now() + 86400000).toISOString(),
      }).expect(400);
      await owner.query(
        "UPDATE admin_sessions SET step_up_expires_at=NULL WHERE id=$1",
        [sessions[0].sessionId],
      );
      await send(body).expect(428);
      await sessions[0].agent
        .post(base + "/demo/step-up")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[0].csrf)
        .send({})
        .expect(200);
      const response = await send(body).expect(200);
      assert.match(response.headers["cache-control"], /no-store/);
      await assert.rejects(
        db.query("SELECT ertad.position_revision_snapshot($1,$2)", [
          org,
          f.dest,
        ]),
      );
      await assert.rejects(
        db.query(
          "SELECT ertad.membership_before_revision_command($1,$2,$3,$4,$5)",
          [
            sessions[0].sessionId,
            sessions[0].sessionTokenHash,
            "revisionOptions",
            org,
            JSON.stringify({ positionId: f.dest }),
          ],
        ),
      );
    },
  );
  if (process.argv.includes("--rollout-browser")) {
    const { enableDemoPositions } = await import("./web-demo-positions");
    await owner.query("BEGIN");
    await enableDemoPositions(owner, access);
    await owner.query("COMMIT");
    const f = await rollout.revision(),
      second = randomUUID();
    await owner.query(
      "UPDATE positions SET name='Browser adopted position' WHERE id=$1",
      [f.dest],
    );
    await owner.query(
      "UPDATE organization_member_labels SET display_name='Browser first member' WHERE member_id=$1",
      [f.user],
    );
    await owner.query("UPDATE memberships SET valid_until=NULL WHERE id=$1", [
      f.m.id,
    ]);
    await owner.query("INSERT INTO member_users(id) VALUES($1)", [second]);
    await owner.query(
      "INSERT INTO organization_member_labels VALUES($1,$2,'Browser second member')",
      [org, second],
    );
    await owner.query(
      "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,status,valid_from) VALUES($1,$2,$3,$4,1,'suspended',now()-interval '2 days')",
      [org, second, a, f.source],
    );
    const before = (
      await owner.query(
        "SELECT * FROM memberships WHERE position_id=$1 ORDER BY user_id",
        [f.source],
      )
    ).rows;
    const { runPositionRolloutBrowser } =
      await import("./position-rollout-browser");
    await runPositionRolloutBrowser(app, access);
    for (const old of before) {
      const current = (
        await owner.query(
          "SELECT * FROM memberships WHERE user_id=$1 AND position_id=$2",
          [old.user_id, f.dest],
        )
      ).rows;
      assert.equal(current.length, 1);
      assert.deepEqual(current[0], {
        ...old,
        id: current[0].id,
        position_id: f.dest,
        version: 0,
      });
      assert.equal(
        (
          await owner.query("SELECT status FROM memberships WHERE id=$1", [
            old.id,
          ])
        ).rows[0].status,
        "ended",
      );
    }
    console.log(
      "PASS browser adoption persisted separate retained-history rows with unchanged original terms and suspended status",
    );
  }
  if (process.argv.includes("--suspension-browser")) {
    const f = await fixture();
    await work(f);
    await owner.query(
      "UPDATE positions SET name='Browser membership role' WHERE id=$1",
      [f.source],
    );
    const before = (
      await owner.query("SELECT * FROM memberships WHERE id=$1", [f.m.id])
    ).rows[0];
    const assignments = (
      await owner.query(
        "SELECT to_jsonb(a) data FROM work_assignments a WHERE user_id=$1",
        [f.user],
      )
    ).rows;
    const { runMembershipLifecycleBrowser } =
      await import("./membership-lifecycle-browser");
    await runMembershipLifecycleBrowser(
      app,
      access,
      f.user,
      f.dest,
      "suspension",
    );
    assert.deepEqual(
      (await owner.query("SELECT * FROM memberships WHERE id=$1", [f.m.id]))
        .rows[0],
      { ...before, version: before.version + 2 },
    );
    assert.deepEqual(
      (
        await owner.query(
          "SELECT to_jsonb(a) data FROM work_assignments a WHERE user_id=$1",
          [f.user],
        )
      ).rows,
      assignments,
    );
    console.log(
      "PASS browser suspension/restoration preserved the membership term and active assignment",
    );
  }
  if (process.argv.includes("--browser")) {
    // The browser uses fresh identities/requests after the SQL adversarial cases.
    const f = await fixture();
    await owner.query(
      "UPDATE positions SET name='Browser destination role' WHERE id=$1",
      [f.dest],
    );
    const { runMembershipLifecycleBrowser } =
      await import("./membership-lifecycle-browser");
    await runMembershipLifecycleBrowser(app, access, f.user, f.dest);
    const records = (
      await owner.query("SELECT status FROM memberships WHERE user_id=$1", [
        f.user,
      ])
    ).rows;
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.status === "ended"));
    console.log(
      "PASS browser mutations persisted as two ended memberships with retained identity",
    );
  }
  console.log(
    browserOnly
      ? "PASS isolated position rollout browser fixture"
      : `PASS ${checks} membership lifecycle scenarios; isolated database only`,
  );
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
