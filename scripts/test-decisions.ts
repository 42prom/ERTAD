import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_decisions_test_${randomBytes(8).toString("hex")}`,
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
  await check(
    "existing roles gain no implicit decision authority",
    async () => {
      assert.deepEqual(await command(2, "contexts"), []);
    },
  );
  await owner.query("BEGIN");
  await enableDemoDecisions(owner, access);
  await owner.query("COMMIT");
  const fresh = (unitId = a) => ({
    key: randomUUID(),
    unitId,
    title: "Synthetic planning poll",
    description: "Choose a synthetic activity",
    options: ["Option A", "Option B"],
    quorum: 50,
    closesAt: new Date(Date.now() + 3600000).toISOString(),
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
  let id = "";
  await check(
    "create, bounded scope, draft list and retry binding",
    async () => {
      const input = fresh();
      const created = await command(2, "create", input);
      id = created.id;
      assert.deepEqual(await command(2, "create", input), created);
      await denied(
        command(2, "create", { ...input, title: "Changed payload" }),
        409,
      );
      await denied(command(4, "detail", { id }));
      await denied(command(4, "create", fresh(a)));
      assert.equal((await command(2, "list", { view: "draft" })).total, 1);
      assert.equal((await command(4, "list", { view: "draft" })).total, 0);
      await denied(
        command(2, "create", { ...fresh(), privacy: "public" as any }),
        400,
      );
      await denied(
        command(2, "create", { ...fresh(), options: ["Same", "same"] }),
        400,
      );
    },
  );
  await check("versioned draft editing and snapshot publication", async () => {
    const definition = fresh();
    await command(2, "update", {
      ...definition,
      id,
      version: 1,
      title: "Updated synthetic poll",
    });
    await denied(command(2, "update", { ...definition, id, version: 1 }), 409);
    await transition(2, "publish", id);
    const detail = await command(3, "detail", { id });
    assert.equal(detail.electorate, 2);
    assert.equal(detail.privacy, "named");
    assert.equal(detail.results, undefined);
    await denied(command(2, "update", { ...fresh(), id, version: 3 }), 409);
    await denied(command(4, "vote", { id, key: randomUUID(), choice: 0 }));
  });
  await check(
    "one vote, exact retry, hidden live results and deadline closure",
    async () => {
      const vote = { id, key: randomUUID(), choice: 0 };
      await command(2, "vote", vote);
      await command(2, "vote", vote);
      await denied(command(2, "vote", { ...vote, choice: 1 }), 409);
      await denied(command(2, "vote", { ...vote, key: randomUUID() }), 409);
      assert.equal((await command(2, "detail", { id })).results, undefined);
      await command(3, "vote", { id, key: randomUUID(), choice: 1 });
      await transition(2, "close", id);
      const result = await command(3, "detail", { id });
      assert.equal(result.participation, 2);
      assert.deepEqual(
        result.results.map((x: any) => x.votes),
        [1, 1],
      );
      await command(2, "vote", vote);
      await denied(
        command(3, "vote", { id, key: randomUUID(), choice: 0 }),
        409,
      );
    },
  );
  await check(
    "empty audience and cancelled polls cannot accept votes",
    async () => {
      const empty = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 LIMIT 1",
          [org, a],
        )
      ).rows[0].id;
      const draft = await command(2, "create", fresh(empty));
      await denied(transition(2, "publish", draft.id), 409);
      await transition(2, "cancel", draft.id);
      assert.equal(
        (await command(2, "detail", { id: draft.id })).status,
        "cancelled",
      );
      await denied(transition(2, "publish", draft.id), 409);
    },
  );
  await check(
    "HTTP validation, CSRF, Origin and runtime table restrictions",
    async () => {
      await request(app)
        .get(base + "/decisions/contexts")
        .expect(401);
      await sessions[2].agent
        .post(base + "/decisions/create")
        .set("Origin", origin)
        .send({ ...fresh(), organizationId: org })
        .expect(403);
      await sessions[2].agent
        .post(base + "/decisions/create")
        .set("Origin", "http://invalid.local")
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send({ ...fresh(), organizationId: org })
        .expect(403);
      await sessions[2].agent
        .post(base + "/decisions/create")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send({ ...fresh(), organizationId: org, title: "x" })
        .expect(400);
      await assert.rejects(
        db.query("SELECT * FROM ertad.decision_named_votes"),
        (e: any) => e.code === "42501",
      );
      await assert.rejects(
        db.query("DELETE FROM ertad.decisions"),
        (e: any) => e.code === "42501",
      );
    },
  );
  await check("concurrent publication and votes commit once", async () => {
    const poll = await command(2, "create", fresh());
    const publish = { id: poll.id, key: randomUUID(), version: 1 };
    await Promise.all([
      command(2, "publish", publish),
      command(2, "publish", publish),
    ]);
    const vote = { id: poll.id, key: randomUUID(), choice: 1 };
    await Promise.all([command(3, "vote", vote), command(3, "vote", vote)]);
    const raced = await Promise.allSettled([
      command(2, "vote", { ...vote, key: randomUUID(), choice: 0 }),
      command(2, "vote", { ...vote, key: randomUUID(), choice: 1 }),
    ]);
    assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      Number(
        (
          await owner.query(
            "SELECT count(*) FROM decision_named_votes WHERE decision_id=$1",
            [poll.id],
          )
        ).rows[0].count,
      ),
      2,
    );
  });
  await check(
    "revocation and post-publication membership cannot expand electorate",
    async () => {
      const poll = await command(2, "create", fresh());
      await transition(2, "publish", poll.id);
      const membership = (
        await owner.query(
          "SELECT membership_id FROM decision_electorate WHERE decision_id=$1 AND user_id=$2",
          [poll.id, access.accounts[3].memberId],
        )
      ).rows[0].membership_id;
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=$1",
        [membership],
      );
      await denied(
        command(3, "vote", { id: poll.id, key: randomUUID(), choice: 0 }),
      );
      await owner.query("UPDATE memberships SET status='active' WHERE id=$1", [
        membership,
      ]);
      const position = (
        await owner.query("SELECT position_id FROM memberships WHERE id=$1", [
          membership,
        ])
      ).rows[0].position_id;
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
        [org, access.accounts[0].memberId, a, position],
      );
      await denied(
        command(0, "vote", { id: poll.id, key: randomUUID(), choice: 0 }),
      );
      assert.equal((await command(2, "detail", { id: poll.id })).electorate, 2);
    },
  );
  await check(
    "session, step-up and changed ancestry are rechecked",
    async () => {
      await owner.query(
        "UPDATE admin_sessions SET step_up_expires_at=NULL WHERE id=$1",
        [sessions[2].sessionId],
      );
      await denied(command(2, "create", fresh()), 428);
      await owner.query(
        "UPDATE admin_sessions SET step_up_expires_at=now()+interval '5 minutes' WHERE id=$1",
        [sessions[2].sessionId],
      );
      const poll = await command(2, "create", fresh());
      await transition(2, "publish", poll.id);
      const root = access.accounts[0].unitId;
      await owner.query(
        "UPDATE units SET parent_id=$1 WHERE organization_id=$2 AND id=$3",
        [b, org, a],
      );
      await denied(
        command(2, "vote", { id: poll.id, key: randomUUID(), choice: 0 }),
        409,
      );
      await owner.query(
        "UPDATE units SET parent_id=$1 WHERE organization_id=$2 AND id=$3",
        [root, org, a],
      );
      await owner.query(
        "UPDATE admin_sessions SET revoked_at=now() WHERE id=$1",
        [sessions[2].sessionId],
      );
      await denied(command(2, "detail", { id: poll.id }));
      await owner.query(
        "UPDATE admin_sessions SET revoked_at=NULL WHERE id=$1",
        [sessions[2].sessionId],
      );
    },
  );
  await check(
    "strict audit failure and expiry during audit roll back votes",
    async () => {
      const { SecurityService } =
        await import("../backend/src/services/security");
      const poll = await command(2, "create", fresh());
      await transition(2, "publish", poll.id);
      const original = SecurityService.logAuditEventInTransaction;
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw new Error("Synthetic audit outage");
        };
        await assert.rejects(
          command(2, "vote", { id: poll.id, key: randomUUID(), choice: 0 }),
          /Synthetic audit outage/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        Number(
          (
            await owner.query(
              "SELECT count(*) FROM decision_named_votes WHERE decision_id=$1",
              [poll.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      await owner.query(
        "UPDATE decisions SET closes_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [poll.id],
      );
      try {
        SecurityService.logAuditEventInTransaction = async (
          ...args: Parameters<typeof original>
        ) => {
          await original(...args);
          await new Promise((resolve) => setTimeout(resolve, 1100));
        };
        await denied(
          command(2, "vote", { id: poll.id, key: randomUUID(), choice: 0 }),
          409,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        Number(
          (
            await owner.query(
              "SELECT count(*) FROM decision_named_votes WHERE decision_id=$1",
              [poll.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      const events = (
        await owner.query(
          "SELECT payload::jsonb FROM audit_log WHERE event_type='DECISION_COMMAND'",
        )
      ).rows;
      for (const event of events) {
        assert.equal(event.payload.choice, undefined);
        assert.equal(event.payload.options, undefined);
        assert.equal(event.payload.title, undefined);
      }
    },
  );
  await check(
    "council, regional and group-team poll authority follows persisted hierarchy",
    async () => {
      const root = access.accounts[0].unitId;
      const group = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 ORDER BY id LIMIT 1",
          [org, a],
        )
      ).rows[0].id;
      const bundle = "4be38062-e4e7-4c30-a17d-fcb0a305a610";
      // Re-scope two existing synthetic identities in this disposable database only.
      // Their account labels do not grant authority in the new group or their former region.
      const members = access.accounts
        .slice(4)
        .map((account) => account.memberId);
      const prior = (
        await owner.query(
          "UPDATE memberships m SET status='suspended' FROM positions p WHERE m.organization_id=$1 AND m.user_id=ANY($2::uuid[]) AND m.status='active' AND p.organization_id=m.organization_id AND p.id=m.position_id AND p.bundle_id=$3 RETURNING m.id",
          [org, members, bundle],
        )
      ).rows.map((row) => row.id);
      const position = randomUUID(),
        added: string[] = [];
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic group leadership team',$4,1)",
        [org, position, group, bundle],
      );
      try {
        for (const member of members)
          added.push(
            (
              await owner.query(
                "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day') RETURNING id",
                [org, member, group, position],
              )
            ).rows[0].id,
          );
        for (const index of [4, 5]) {
          assert.deepEqual(
            (await command(index, "audiences")).map(
              (unit: { id: string }) => unit.id,
            ),
            [group],
          );
          await denied(command(index, "create", fresh(a)));
          await denied(command(index, "create", fresh(b)));
          await denied(command(index, "create", fresh(root)));
        }
        const local = await command(4, "create", fresh(group));
        await transition(5, "publish", local.id);
        assert.equal(
          (await command(4, "detail", { id: local.id })).electorate,
          2,
        );
        assert.equal(
          (await command(2, "detail", { id: local.id })).canManage,
          true,
        );
        assert.equal(
          (await command(0, "detail", { id: local.id })).canManage,
          true,
        );
        assert.equal(
          (await command(2, "detail", { id: local.id })).canVote,
          false,
        );
        await command(4, "vote", {
          id: local.id,
          key: randomUUID(),
          choice: 0,
        });
        await command(5, "vote", {
          id: local.id,
          key: randomUUID(),
          choice: 1,
        });
        await transition(5, "close", local.id);
        assert.equal(
          (await command(0, "detail", { id: local.id })).participation,
          2,
        );
        const selected = await command(0, "create", fresh(b));
        await denied(command(2, "detail", { id: selected.id }));
        await transition(1, "cancel", selected.id);
        const everyone = await command(0, "create", fresh(root));
        await transition(1, "publish", everyone.id);
        assert.equal(
          (await command(0, "detail", { id: everyone.id })).electorate,
          6,
        );
        for (const index of [2, 3, 4, 5]) {
          assert.equal(
            (await command(index, "detail", { id: everyone.id })).canVote,
            true,
          );
          await denied(transition(index, "close", everyone.id));
        }
        await transition(1, "close", everyone.id);
      } finally {
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE organization_id=$1 AND id=ANY($2::uuid[])",
          [org, added],
        );
        await owner.query(
          "UPDATE memberships SET status='active' WHERE organization_id=$1 AND id=ANY($2::uuid[])",
          [org, prior],
        );
      }
    },
  );
  await check(
    "survey definition, all five question types, complete answers and aggregate results",
    async () => {
      const common = { required: true };
      const questions = [
        {
          ...common,
          id: randomUUID(),
          title: "Synthetic single choice",
          type: "single_choice",
          options: ["One", "Two"],
        },
        {
          ...common,
          id: randomUUID(),
          title: "Synthetic multiple choice",
          type: "multiple_choice",
          options: ["One", "Two", "Three"],
        },
        {
          ...common,
          id: randomUUID(),
          title: "Synthetic feedback",
          type: "text",
          maxLength: 50,
          placeholder: "Describe a synthetic idea",
          required: false,
        },
        {
          ...common,
          id: randomUUID(),
          title: "Synthetic rating",
          type: "rating_scale",
          min: 1,
          max: 5,
          minLabel: "Not useful",
          maxLabel: "Very useful",
        },
        {
          ...common,
          id: randomUUID(),
          title: "Synthetic ranking",
          type: "ranked_choice",
          options: ["One", "Two", "Three"],
        },
      ];
      const definition = { ...fresh(), kind: "survey", options: [], questions };
      for (const invalid of [
        { ...questions[2], placeholder: 12 },
        { ...questions[2], placeholder: "x".repeat(201) },
        { ...questions[3], minLabel: null },
        { ...questions[3], maxLabel: "x".repeat(121) },
        { ...questions[0], minLabel: "Wrong question type" },
      ]) {
        await denied(
          command(2, "create", {
            ...definition,
            key: randomUUID(),
            questions: [invalid],
          }),
          400,
        );
        const sql = await owner.query(
          "SELECT ertad.decision_definition_valid('survey','{}'::text[],NULL,$1::jsonb) AS valid",
          [JSON.stringify([invalid])],
        );
        assert.equal(sql.rows[0].valid, false);
      }
      await denied(
        command(2, "create", {
          ...definition,
          questions: [questions[0], questions[0]],
        }),
        400,
      );
      await denied(command(2, "create", { ...definition, threshold: 50 }), 400);
      const survey = await command(2, "create", definition);
      assert.deepEqual(
        (await command(2, "detail", { id: survey.id })).questions,
        questions,
      );
      await transition(2, "publish", survey.id);
      const answers = {
        [questions[0].id]: 0,
        [questions[1].id]: [0, 2],
        [questions[2].id]: "Synthetic feedback only",
        [questions[3].id]: 2,
        [questions[4].id]: [0, 1, 2],
      };
      await denied(
        command(2, "vote", { id: survey.id, key: randomUUID(), choice: 0 }),
        400,
      );
      await denied(
        command(2, "vote", { id: survey.id, key: randomUUID(), answers: {} }),
        400,
      );
      for (const invalid of [
        { ...answers, [questions[1].id]: [0, 0] },
        { ...answers, [questions[1].id]: [8] },
        { ...answers, [questions[3].id]: 6 },
        { ...answers, [questions[4].id]: [0, 1] },
        { ...answers, [questions[2].id]: "x".repeat(51) },
        { ...answers, [randomUUID()]: 0 },
      ])
        await denied(
          command(2, "vote", {
            id: survey.id,
            key: randomUUID(),
            answers: invalid,
          }),
          400,
        );
      // SQL is an explicit boundary, including callers bypassing HTTP/Zod.
      await assert.rejects(
        owner.query("SELECT ertad.decision_command($1,$2,$3,$4,$5)", [
          sessions[2].sessionId,
          sessions[2].sessionTokenHash,
          "vote",
          org,
          JSON.stringify({
            id: survey.id,
            key: randomUUID(),
            answers: { ...answers, [questions[3].id]: 1.5 },
          }),
        ]),
        (error: any) => error.code === "22023",
      );
      const write = { id: survey.id, key: randomUUID(), answers };
      await command(2, "vote", write);
      await command(2, "vote", write);
      await denied(
        command(2, "vote", {
          ...write,
          answers: { ...answers, [questions[0].id]: 1 },
        }),
        409,
      );
      assert.equal(
        (await command(3, "detail", { id: survey.id })).surveyResults,
        undefined,
      );
      await denied(
        command(2, "update", { ...definition, id: survey.id, version: 2 }),
        409,
      );
      await command(3, "vote", {
        id: survey.id,
        key: randomUUID(),
        answers: {
          [questions[0].id]: 1,
          [questions[1].id]: [1],
          [questions[3].id]: 4,
          [questions[4].id]: [1, 0, 2],
        },
      });
      await transition(2, "close", survey.id);
      const result = await command(2, "detail", { id: survey.id });
      assert.equal(result.participation, 2);
      assert.equal(result.voted, true);
      assert.deepEqual(
        result.surveyResults[0].results.map((r: any) => r.votes),
        [1, 1],
      );
      assert.deepEqual(
        result.surveyResults[1].results.map((r: any) => r.votes),
        [1, 1, 1],
      );
      assert.deepEqual(result.surveyResults[2].texts, [
        "Synthetic feedback only",
      ]);
      assert.equal(result.surveyResults[3].average, 3);
      assert.deepEqual(
        result.surveyResults[4].results.map((r: any) => r.votes),
        [5, 5, 2],
      );
      await assert.rejects(
        db.query("SELECT answers FROM ertad.decision_survey_responses"),
        (error: any) => error.code === "42501",
      );
      const bundle = randomUUID(),
        position = randomUUID();
      await owner.query(
        "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO permission_grants VALUES($1,$2,1,'decision.read','unit')",
        [org, bundle],
      );
      await owner.query(
        "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic results reader',$4,1)",
        [org, position, a, bundle],
      );
      const membership = (
        await owner.query(
          "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day') RETURNING id",
          [org, access.accounts[4].memberId, a, position],
        )
      ).rows[0].id;
      try {
        const viewer = await command(4, "detail", { id: survey.id });
        assert.equal(viewer.canManage, false);
        assert.equal(viewer.surveyResults[2].answered, 1);
        assert.equal(viewer.surveyResults[2].texts, undefined);
      } finally {
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE id=$1",
          [membership],
        );
      }
    },
  );
  await check(
    "referendum threshold, abstentions, ties and quorum have distinct outcomes",
    async () => {
      await denied(
        command(2, "create", { ...fresh(), kind: "referendum", threshold: 60 }),
        400,
      );
      const cases: [number[], number, string][] = [
        [[0, 0, 2], 50, "accepted"],
        [[0, 1, 2], 50, "tie"],
        [[2, 2, 2], 50, "no_decision"],
        [[0], 100, "inquorate"],
        [[1, 1, 0], 50, "rejected"],
      ];
      for (const [choices, quorum, outcome] of cases) {
        const poll = await command(2, "create", {
          ...fresh(),
          kind: "referendum",
          threshold: 60,
          quorum,
          options: ["Yes", "No", "Abstain"],
        });
        await transition(2, "publish", poll.id);
        assert.equal(
          (await command(2, "detail", { id: poll.id })).outcome,
          undefined,
        );
        for (const [i, choice] of choices.entries())
          await command([2, 3, 0][i], "vote", {
            id: poll.id,
            key: randomUUID(),
            choice,
          });
        await transition(2, "close", poll.id);
        assert.equal(
          (await command(2, "detail", { id: poll.id })).outcome,
          outcome,
        );
      }
    },
  );
  await check(
    "survey races and strict audit rollback preserve one response",
    async () => {
      const q = {
        id: randomUUID(),
        title: "Synthetic race choice",
        type: "single_choice",
        required: true,
        options: ["One", "Two"],
      };
      const poll = await command(2, "create", {
        ...fresh(),
        kind: "survey",
        options: [],
        questions: [q],
      });
      await transition(2, "publish", poll.id);
      const race = await Promise.allSettled(
        [0, 1].map((value) =>
          command(2, "vote", {
            id: poll.id,
            key: randomUUID(),
            answers: { [q.id]: value },
          }),
        ),
      );
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      const { SecurityService } =
        await import("../backend/src/services/security");
      const original = SecurityService.logAuditEventInTransaction;
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw new Error("Synthetic survey audit outage");
        };
        await assert.rejects(
          command(3, "vote", {
            id: poll.id,
            key: randomUUID(),
            answers: { [q.id]: 1 },
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        Number(
          (
            await owner.query(
              "SELECT count(*) FROM decision_survey_responses WHERE decision_id=$1",
              [poll.id],
            )
          ).rows[0].count,
        ),
        1,
      );
      await transition(2, "cancel", poll.id);
      assert.equal(
        (await command(2, "detail", { id: poll.id })).surveyResults,
        undefined,
      );
      for (const event of (
        await owner.query(
          "SELECT payload::jsonb FROM audit_log WHERE event_type='DECISION_COMMAND'",
        )
      ).rows)
        assert.equal(event.payload.answers, undefined);
    },
  );
  await check(
    "election candidates roundtrip, scope, immutable ballot, duplicate vote denial and no appointment",
    async () => {
      const definition = {
        ...fresh(),
        kind: "election",
        title: "Synthetic committee election",
        options: ["Candidate A", "Candidate B"],
      };
      for (const invalid of [
        { ...definition, options: ["Candidate A", " candidate a "] },
        { ...definition, threshold: 60 },
        { ...definition, questions: [] },
        { ...definition, kind: "unsupported" },
      ])
        await denied(command(2, "create", invalid), 400);
      await denied(command(4, "create", definition));
      const created = await sessions[2].agent
        .post(base + "/decisions/create")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send({ organizationId: org, ...definition })
        .expect(200);
      const election = created.body;
      assert.ok(election.id);
      assert.equal((await command(2, "create", definition)).id, election.id);
      await denied(command(4, "detail", { id: election.id }));
      const candidates = ["Candidate A", "Candidate B", "Candidate C"];
      await command(2, "update", {
        ...definition,
        key: randomUUID(),
        id: election.id,
        version: 1,
        options: candidates,
      });
      const edited = await command(2, "detail", { id: election.id });
      assert.equal(edited.kind, "election");
      assert.deepEqual(edited.options, candidates);
      const grantsBefore = (
        await owner.query(
          "SELECT id,status FROM memberships WHERE organization_id=$1 ORDER BY id",
          [org],
        )
      ).rows;
      await transition(2, "publish", election.id);
      await denied(
        command(2, "update", {
          ...definition,
          key: randomUUID(),
          id: election.id,
          version: 3,
        }),
        409,
      );
      assert.equal(
        (await command(3, "detail", { id: election.id })).results,
        undefined,
      );
      const ballot = { id: election.id, key: randomUUID(), choice: 2 };
      await command(2, "vote", ballot);
      await command(2, "vote", ballot);
      await denied(
        command(2, "vote", { ...ballot, key: randomUUID(), choice: 0 }),
        409,
      );
      await command(3, "vote", {
        id: election.id,
        key: randomUUID(),
        choice: 2,
      });
      await transition(3, "close", election.id);
      const result = await command(0, "detail", { id: election.id });
      assert.equal(result.kind, "election");
      assert.equal(result.participation, 2);
      assert.deepEqual(
        result.results,
        candidates.map((label, i) => ({ label, votes: i === 2 ? 2 : 0 })),
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT id,status FROM memberships WHERE organization_id=$1 ORDER BY id",
            [org],
          )
        ).rows,
        grantsBefore,
      );
    },
  );
  await check(
    "multi-unit audience estimate/exclusions, scheduled opening, nominations and unlinkable anonymous voting with k>=10 floor",
    async () => {
      const root = access.accounts[0].unitId;
      const rootEstimate = await command(0, "estimate", {
        includedUnitIds: [root],
        excludedUnitIds: [b],
      });
      const fullEstimate = await command(0, "estimate", {
        includedUnitIds: [root],
        excludedUnitIds: [],
      });
      assert(fullEstimate.electorateCount >= rootEstimate.electorateCount);
      assert.equal(fullEstimate.meetsAnonymousFloor, fullEstimate.electorateCount >= 10);

      await denied(
        command(2, "estimate", {
          includedUnitIds: [a, b],
          excludedUnitIds: [],
        }),
        403,
      );

      const futureOpen = new Date(Date.now() + 60 * 60_000).toISOString();
      const futureClose = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
      const scheduled = await command(2, "create", {
        key: randomUUID(),
        unitId: a,
        title: "Scheduled multi-unit poll",
        description: "Opens later",
        options: ["Alpha", "Beta"],
        quorum: 50,
        opensAt: futureOpen,
        closesAt: futureClose,
        kind: "election",
        governanceMode: "binding_review",
      });
      await command(2, "nominate", {
        key: randomUUID(),
        id: scheduled.id,
        version: 1,
        candidateLabel: "Gamma",
      });
      await command(2, "withdraw_nomination", {
        key: randomUUID(),
        id: scheduled.id,
        version: 2,
        candidateLabel: "Beta",
        reason: "Candidate stepped down before publication",
      });
      await command(2, "publish", {
        key: randomUUID(),
        id: scheduled.id,
        version: 3,
      });
      const scheduledDetail = await command(2, "detail", { id: scheduled.id });
      assert.equal(scheduledDetail.status, "scheduled");
      assert.equal(scheduledDetail.canVote, false);
      assert.deepEqual(scheduledDetail.options, ["Alpha", "Gamma"]);
      await denied(
        command(2, "vote", {
          id: scheduled.id,
          key: randomUUID(),
          choice: 0,
        }),
        409,
      );

      const smallAnon = await command(2, "create", {
        key: randomUUID(),
        unitId: a,
        title: "Small anonymous poll blocked at k<10",
        description: "Should fail publish",
        options: ["Yes", "No"],
        quorum: 50,
        closesAt: futureClose,
        privacy: "anonymous",
      });
      await denied(
        command(2, "publish", {
          key: randomUUID(),
          id: smallAnon.id,
          version: 1,
        }),
        409,
      );

      const anonMembers: string[] = [];
      const bPos = (
        await owner.query(
          `SELECT p.id, p.bundle_version FROM positions p
           JOIN permission_bundles pb ON pb.organization_id=p.organization_id AND pb.id=p.bundle_id AND pb.version=p.bundle_version
           JOIN permission_grants pg ON pg.organization_id=pb.organization_id AND pg.bundle_id=pb.id AND pg.bundle_version=pb.version
           WHERE p.organization_id=$1 AND p.unit_id=$2 AND p.status='active' AND pb.status='approved' AND pg.permission='decision.vote' LIMIT 1`,
          [org, a],
        )
      ).rows[0];
      assert(bPos);
      for (let i = 0; i < 10; i++) {
        const uid = randomUUID();
        const mid = randomUUID();
        await owner.query(
          "INSERT INTO admin_users(id,email,password_hash,role) SELECT $1,$2,password_hash,'observer' FROM admin_users WHERE id=$3",
          [uid, `anon-voter-${i}-${randomUUID().slice(0, 6)}@example.test`, access.accounts[2].id],
        );
        await owner.query("INSERT INTO member_users(id,web_account_id) VALUES($1,$2)", [mid, uid]);
        await owner.query(
          "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '7 days')",
          [org, mid, a, bPos.id, bPos.bundle_version],
        );
        anonMembers.push(mid);
      }
      const largeAnon = await command(2, "create", {
        key: randomUUID(),
        unitId: a,
        title: "Anonymous poll >= 10",
        description: "Unlinkable storage test",
        options: ["First", "Second"],
        quorum: 10,
        closesAt: futureClose,
        privacy: "anonymous",
      });
      await command(2, "publish", {
        key: randomUUID(),
        id: largeAnon.id,
        version: 1,
      });
      const voteKey = randomUUID();
      await command(2, "vote", {
        id: largeAnon.id,
        key: voteKey,
        choice: 1,
      });
      const receiptRow = (
        await owner.query(
          "SELECT payload FROM decision_commands WHERE organization_id=$1 AND actor_id=$2 AND key=$3",
          [org, access.accounts[2].memberId, voteKey],
        )
      ).rows[0];
      assert.deepEqual(receiptRow.payload, { anonymous: true });
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM decision_named_votes WHERE organization_id=$1 AND decision_id=$2",
            [org, largeAnon.id],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM decision_anonymous_ballots WHERE organization_id=$1 AND decision_id=$2 AND choice=1",
            [org, largeAnon.id],
          )
        ).rows[0].n,
        1,
      );
      await owner.query(
        "UPDATE memberships SET status='ended', valid_until=clock_timestamp() WHERE organization_id=$1 AND user_id=ANY($2::uuid[])",
        [org, anonMembers],
      );

      // Verify admin-configurable anonymity floor (k) via security_limits_proposals (no hardcoded k=10).
      const { seedPlatformOperator, enablePlatformLimits } =
        await import("./platform-fixture");
      await owner.query("BEGIN");
      const opUser = await seedPlatformOperator(owner);
      const revUser = await seedPlatformOperator(owner, "reviewer");
      await enablePlatformLimits(owner, opUser.id);
      await enablePlatformLimits(owner, revUser.id);
      await owner.query(
        `INSERT INTO security_limits_proposals(
          proposer_id, request_id, expected_version, api_per_minute, login_failures, lockout_minutes,
          anonymous_min_electorate, reason, status, reviewer_id, review_request_id, reviewed_at, version
        ) VALUES($1,$2,0,120,5,15,3,'traffic_adjustment','approved',$3,$4,clock_timestamp(),1)`,
        [opUser.id, randomUUID(), revUser.id, randomUUID()],
      );
      await owner.query("COMMIT");

      const dynamicCtx = await command(2, "contexts");
      assert.equal(dynamicCtx[0].anonymousMinElectorate, 3);
      const estAt3 = await command(2, "estimate", {
        includedUnitIds: [a],
        excludedUnitIds: [],
      });
      assert.equal(estAt3.electorateCount, 3);
      assert.equal(estAt3.meetsAnonymousFloor, true);
      assert.equal(estAt3.anonymousMinElectorate, 3);

      await denied(
        command(2, "create", {
          key: randomUUID(),
          unitId: a,
          title: "Lower than admin policy k=3 blocked",
          description: "Should reject below policy floor",
          options: ["Yes", "No"],
          quorum: 50,
          closesAt: futureClose,
          privacy: "anonymous",
          anonymousMinElectorate: 2,
        }),
        400,
      );

      const okAt3 = await command(2, "create", {
        key: randomUUID(),
        unitId: a,
        title: "Allowed when admin lowered floor to k=3",
        description: "Dynamic threshold test",
        options: ["Yes", "No"],
        quorum: 50,
        closesAt: futureClose,
        privacy: "anonymous",
      });
      const publishedAt3 = await command(2, "publish", {
        key: randomUUID(),
        id: okAt3.id,
        version: 1,
      });
      assert.equal(publishedAt3.status, "open");

      const strictAt5 = await command(2, "create", {
        key: randomUUID(),
        unitId: a,
        title: "Organizer tightened poll floor to k=5",
        description: "Per-poll override >= system floor",
        options: ["Yes", "No"],
        quorum: 50,
        closesAt: futureClose,
        privacy: "anonymous",
        anonymousMinElectorate: 5,
      });
      await denied(
        command(2, "publish", {
          key: randomUUID(),
          id: strictAt5.id,
          version: 1,
        }),
        409,
      );

      // Restore default k=10 policy version cleanly after test.
      await owner.query(
        `INSERT INTO security_limits_proposals(
          proposer_id, request_id, expected_version, api_per_minute, login_failures, lockout_minutes,
          anonymous_min_electorate, reason, status, reviewer_id, review_request_id, reviewed_at, version
        ) VALUES($1,$2,1,120,5,15,10,'security_tightening','approved',$3,$4,clock_timestamp(),2)`,
        [opUser.id, randomUUID(), revUser.id, randomUUID()],
      );
    },
  );
  if (process.argv.includes("--browser")) {
    const { runDecisionsBrowser } = await import("./decisions-browser");
    await runDecisionsBrowser(app, access);
    checks++;
  }
  if (
    process.argv.includes("--browser") ||
    process.argv.includes("--formats-browser")
  ) {
    const { runDecisionFormatsBrowser } =
      await import("./decision-formats-browser");
    await runDecisionFormatsBrowser(app, access);
    checks++;
  }
  console.log(`PASS ${checks} decision scenarios; disposable database only`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
