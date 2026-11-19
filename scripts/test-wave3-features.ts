import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_wave3_test_${randomBytes(8).toString("hex")}`,
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

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const memoryObjects = new Map<string, Buffer>();
const memoryStore = {
  put: async (key: string, bytes: Buffer) => {
    memoryObjects.set(key, Buffer.from(bytes));
  },
  get: async (key: string) => {
    const val = memoryObjects.get(key);
    if (!val) throw new Error("Missing object " + key);
    return Buffer.from(val);
  },
  delete: async (key: string) => {
    memoryObjects.delete(key);
  },
};

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
    { enableDemoDecisions } = await import("./web-demo-decisions"),
    { enableDemoWork } = await import("./web-demo-work"),
    { enableDemoCollective } = await import("./web-demo-collective");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await enableDemoDecisions(owner, access);
  await enableDemoWork(owner, access);
  await enableDemoCollective(owner, access);
  await owner.query("COMMIT");

  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin"),
    { decisionCommand } = await import("../backend/src/modules/decisions/polls"),
    { collectiveAttachmentUpload, collectiveAttachmentDownload, collectiveCommand } =
      await import("../backend/src/modules/governance/collective");

  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, storage: async () => {} },
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
    const agent = request.agent(app);
    const login = await agent
      .post(base + "/demo/login")
      .set("Origin", origin)
      .send({ accountId: a.id })
      .expect(200);
    await agent
      .post(base + "/demo/step-up")
      .set("Origin", origin)
      .set("X-Admin-Csrf", login.body.csrfToken)
      .send({})
      .expect(200);
    const row = (
      await owner.query(
        'SELECT id AS "sessionId", token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1',
        [a.id],
      )
    ).rows[0];
    sessions.push({ agent, csrf: login.body.csrfToken, ...row });
  }

  const org = access.organizationId;
  const unitA = access.accounts[2].unitId;
  const coordinator = sessions[2];
  const memberOther = sessions[3];
  const outsider = sessions[4];

  await check(
    "conditional survey branching enforces visibleIf on create and vote",
    async () => {
      const q1Id = randomUUID();
      const q2Id = randomUUID();
      const closesAt = new Date(Date.now() + 3600000).toISOString();

      // Forward dependency is rejected at validation time
      await coordinator.agent
        .post(base + "/decisions/create")
        .set("Origin", origin)
        .set("X-Admin-Csrf", coordinator.csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          unitId: unitA,
          kind: "survey",
          title: "Invalid forward rule survey",
          description: "Should fail schema validation",
          options: [],
          questions: [
            {
              id: q1Id,
              title: "First question",
              type: "single_choice",
              required: true,
              options: ["Yes", "No"],
              visibleIf: { questionId: q2Id, equals: "0" },
            },
            {
              id: q2Id,
              title: "Second question",
              type: "single_choice",
              required: true,
              options: ["A", "B"],
            },
          ],
          quorum: 10,
          closesAt,
        })
        .expect(400);

      const createdSurvey = await coordinator.agent
        .post(base + "/decisions/create")
        .set("Origin", origin)
        .set("X-Admin-Csrf", coordinator.csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          unitId: unitA,
          kind: "survey",
          title: "Branching field survey",
          description: "Follow-up appears only for option 0",
          options: [],
          questions: [
            {
              id: q1Id,
              title: "Need logistic support?",
              type: "single_choice",
              required: true,
              options: ["Yes", "No"],
            },
            {
              id: q2Id,
              title: "Describe needed equipment",
              type: "text",
              required: true,
              maxLength: 200,
              visibleIf: { questionId: q1Id, equals: "0" },
            },
          ],
          quorum: 10,
          closesAt,
        })
        .expect(200);
      const surveyId = createdSurvey.body.id as string;

      await coordinator.agent
        .post(base + "/decisions/publish")
        .set("Origin", origin)
        .set("X-Admin-Csrf", coordinator.csrf)
        .send({ organizationId: org, key: randomUUID(), id: surveyId, version: 1 })
        .expect(200);

      // Hidden branch triggered (q1=1) + answer supplied for hidden q2 -> rejected (400)
      await coordinator.agent
        .post(base + "/decisions/vote")
        .set("Origin", origin)
        .set("X-Admin-Csrf", coordinator.csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          id: surveyId,
          answers: { [q1Id]: 1, [q2Id]: "Should not pass when hidden" },
        })
        .expect(400);

      // Visible required branch (q1=0) missing q2 -> rejected (400)
      await coordinator.agent
        .post(base + "/decisions/vote")
        .set("Origin", origin)
        .set("X-Admin-Csrf", coordinator.csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          id: surveyId,
          answers: { [q1Id]: 0 },
        })
        .expect(400);

      // Valid path hiding q2 -> accepted
      await coordinator.agent
        .post(base + "/decisions/vote")
        .set("Origin", origin)
        .set("X-Admin-Csrf", coordinator.csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          id: surveyId,
          answers: { [q1Id]: 1 },
        })
        .expect(200);

      // Valid path showing required q2 -> accepted
      await memberOther.agent
        .post(base + "/decisions/vote")
        .set("Origin", origin)
        .set("X-Admin-Csrf", memberOther.csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          id: surveyId,
          answers: { [q1Id]: 0, [q2Id]: "Two microphones" },
        })
        .expect(200);
    },
  );

  await check(
    "anonymous ballot receiptDigest is one-time, absent from command/participation tables, and sorted on close",
    async () => {
      const bPos = (
        await owner.query(
          `SELECT p.id, p.bundle_version FROM positions p
           JOIN permission_bundles pb ON pb.organization_id=p.organization_id AND pb.id=p.bundle_id AND pb.version=p.bundle_version
           JOIN permission_grants pg ON pg.organization_id=pb.organization_id AND pg.bundle_id=pb.id AND pg.bundle_version=pb.version
           WHERE p.organization_id=$1 AND p.unit_id=$2 AND p.status='active' AND pb.status='approved' AND pg.permission='decision.vote' LIMIT 1`,
          [org, unitA],
        )
      ).rows[0];
      assert.ok(bPos);
      for (let i = 0; i < 10; i++) {
        const uid = randomUUID();
        const mid = randomUUID();
        await owner.query(
          "INSERT INTO admin_users(id,email,password_hash,role) SELECT $1,$2,password_hash,'observer' FROM admin_users WHERE id=$3",
          [uid, `wave3-anon-${i}-${randomUUID().slice(0, 6)}@example.test`, access.accounts[2].id],
        );
        await owner.query("INSERT INTO member_users(id,web_account_id) VALUES($1,$2)", [mid, uid]);
        await owner.query(
          "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '7 days')",
          [org, mid, unitA, bPos.id, bPos.bundle_version],
        );
      }

      const createdAnon = await decisionCommand(coordinator, "create", {
        organizationId: org,
        key: randomUUID(),
        unitId: unitA,
        title: "Anonymous receipt verification poll",
        description: "E2E anonymous receipt digest test",
        options: ["Approve", "Reject"],
        quorum: 10,
        closesAt: new Date(Date.now() + 3600000).toISOString(),
        privacy: "anonymous",
      });
      await decisionCommand(coordinator, "publish", {
        organizationId: org,
        key: randomUUID(),
        id: createdAnon.id,
        version: 1,
      });

      const voteRes = await coordinator.agent
        .post(base + "/decisions/vote")
        .set("Origin", origin)
        .set("X-Admin-Csrf", coordinator.csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          id: createdAnon.id,
          choice: 0,
        })
        .expect(200);
      const receipt = voteRes.body.receiptDigest as string;
      assert.match(receipt, /^[0-9a-f]{16}$/);

      // Vote from second voter too
      const vote2 = await memberOther.agent
        .post(base + "/decisions/vote")
        .set("Origin", origin)
        .set("X-Admin-Csrf", memberOther.csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          id: createdAnon.id,
          choice: 0,
        })
        .expect(200);
      assert.match(vote2.body.receiptDigest, /^[0-9a-f]{16}$/);

      // Unlinkability check: digest never appears in decision_commands or decision_anonymous_participation
      const cmdHits = await owner.query(
        "SELECT count(*)::int AS c FROM decision_commands dc WHERE row_to_json(dc)::text LIKE $1",
        [`%${receipt}%`],
      );
      assert.equal(cmdHits.rows[0].c, 0);
      const partCols = await owner.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='ertad' AND table_name='decision_anonymous_participation'",
      );
      assert.equal(
        partCols.rows.some((r) => String(r.column_name).includes("receipt")),
        false,
      );

      // While open, receiptDigests must remain hidden/empty
      const openDetail = await decisionCommand(coordinator, "detail", {
        organizationId: org,
        id: createdAnon.id,
      });
      assert.equal(openDetail.receiptDigests?.length ?? 0, 0);

      // Close and confirm sorted receipts returned
      await decisionCommand(coordinator, "close", {
        organizationId: org,
        key: randomUUID(),
        id: createdAnon.id,
        version: 2,
      });
      const closedDetail = await decisionCommand(coordinator, "detail", {
        organizationId: org,
        id: createdAnon.id,
      });
      assert.ok(Array.isArray(closedDetail.receiptDigests));
      assert.equal(closedDetail.receiptDigests.length, 2);
      assert.ok(closedDetail.receiptDigests.includes(receipt));
      assert.ok(closedDetail.receiptDigests.includes(vote2.body.receiptDigest));
      assert.deepEqual(
        closedDetail.receiptDigests,
        [...closedDetail.receiptDigests].sort(),
      );
    },
  );

  await check(
    "collective funding receipt attachment uploads, binds to proposal, and enforces unit-scoped download",
    async () => {
      const workCreated = await coordinator.agent
        .post(base + "/work/create")
        .set("Origin", origin)
        .set("X-Admin-Csrf", coordinator.csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          unitId: unitA,
          title: "Wave 3 Funded Activity",
          description: "Task with funding receipt evidence",
          roleLabel: "Coordinator",
          priority: "normal",
          capacity: 2,
          deadline: new Date(Date.now() + 5 * 86400000).toISOString(),
        })
        .expect(200);
      const workId = workCreated.body.id as string;

      // Propose and approve a funding target
      const targetProp = await collectiveCommand(coordinator, "propose", {
        organizationId: org,
        key: randomUUID(),
        unitId: unitA,
        workId,
        kind: "funding_target",
        parameters: {
          currency: "GEL",
          amount: "5000",
          targetVersion: 0,
          purpose: "Wave 3 receipt audit",
        },
        reason: "Approve funding budget",
        deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
      });
      await collectiveCommand(memberOther, "vote", {
        organizationId: org,
        key: randomUUID(),
        id: targetProp.id,
        version: 1,
        choice: "approve",
        reason: "Approved target",
      });

      const uploaded = await collectiveAttachmentUpload(
        coordinator,
        { organizationId: org, unitId: unitA, key: randomUUID() },
        tinyPng,
        "image/png",
        memoryStore,
      );
      assert.ok(uploaded.id);
      assert.equal(uploaded.mediaType, "image/png");

      const receiptProp = await collectiveCommand(coordinator, "propose", {
        organizationId: org,
        key: randomUUID(),
        unitId: unitA,
        workId,
        kind: "funding_receipt",
        attachmentId: uploaded.id,
        parameters: {
          amount: "1500",
          externalRef: "INV-2026-W3",
          memberId: access.accounts[2].memberId,
        },
        reason: "Attach bank receipt evidence",
        deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
      });

      const detail = await collectiveCommand(memberOther, "detail", {
        organizationId: org,
        id: receiptProp.id,
      });
      assert.equal(detail.attachment?.id, uploaded.id);
      assert.equal(detail.attachment?.mediaType, "image/png");

      const downloaded = await collectiveAttachmentDownload(
        memberOther,
        { organizationId: org, attachmentId: uploaded.id },
        memoryStore,
      );
      assert.equal(downloaded.mediaType, "image/png");
      assert.equal(
        createHash("sha256").update(downloaded.bytes).digest("hex"),
        createHash("sha256")
          .update(memoryObjects.get(`collective-files/${org}/${uploaded.id}.bin`)!)
          .digest("hex"),
      );

      // Outsider in separate unit gets 403
      await assert.rejects(
        collectiveAttachmentDownload(
          outsider,
          { organizationId: org, attachmentId: uploaded.id },
          memoryStore,
        ),
        (err: any) => err.statusCode === 403,
      );
    },
  );

  console.log(`ALL ${checks} wave3 checks passed`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) {
    await control.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [database],
    );
    await control.query(`DROP DATABASE IF EXISTS ${database}`);
  }
  await control.end();
}

