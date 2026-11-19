import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_mobilization_test_${randomBytes(8).toString("hex")}`,
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
  const org = access.organizationId;
  const { enableDemoCollective } = await import("./web-demo-collective");
  const { enableDemoContribution } = await import("./web-demo-contribution");
  await owner.query("BEGIN");
  await enableDemoWork(owner, access);
  await enableDemoCollective(owner, access);
  await enableDemoContribution(owner, access);
  await owner.query("COMMIT");
  const { collectiveCommand } =
    await import("../backend/src/modules/governance/collective");
  const command = (
    i: number,
    op: Parameters<typeof workCommand>[1],
    input: object = {},
  ) => workCommand(sessions[i], op, { organizationId: org, ...input });
  const collective = (
    i: number,
    op: Parameters<typeof collectiveCommand>[1],
    input: object = {},
  ) => collectiveCommand(sessions[i], op, { organizationId: org, ...input });
  const detail = (i: number, id: string) => command(i, "detail", { id });
  const act = async (
    i: number,
    op: Parameters<typeof workCommand>[1],
    id: string,
    input: object = {},
  ) =>
    command(i, op, {
      id,
      key: randomUUID(),
      version: (await detail(i, id)).version,
      ...input,
    });
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
  const testMobilization = process.argv.includes("--members")
    ? (await import("./member-directory-tests")).testMemberDirectory
    : process.argv.includes("--editing")
      ? (await import("./work-editing-tests")).testWorkEditing
      : process.argv.includes("--recognition")
        ? (await import("./work-recognition-tests")).testWorkRecognition
        : process.argv.includes("--events")
          ? (await import("./event-tests")).testEvents
          : process.argv.includes("--review-hierarchy")
            ? (await import("./work-review-tests")).testWorkReview
            : process.argv.includes("--materials")
              ? (await import("./work-materials-tests")).testWorkMaterials
              : (await import("./mobilization-tests")).testMobilization;
  await testMobilization({
    app,
    command,
    collective,
    detail,
    act,
    owner,
    access,
    check,
    denied,
    sessions,
  });
  if (process.argv.includes("--materials")) {
    await check(
      "material HTTP writes require a session, CSRF and a strict schema",
      async () => {
        const path = base + "/work/materials";
        await request(app)
          .post(path)
          .set("Origin", origin)
          .send({})
          .expect(401);
        await sessions[2].agent
          .post(path)
          .set("Origin", origin)
          .send({})
          .expect(403);
        await sessions[2].agent
          .post(path)
          .set("Origin", origin)
          .set("X-Admin-Csrf", sessions[2].csrf)
          .send({
            organizationId: org,
            id: randomUUID(),
            key: randomUUID(),
            version: 1,
            links: [{ title: "Invalid", url: "javascript:alert(1)" }],
          })
          .expect(400);
        await sessions[2].agent
          .get(base + "/work/list")
          .query({ organizationId: org })
          .expect("Cache-Control", "no-store")
          .expect(200);
      },
    );
  }
  if (process.argv.includes("--browser")) {
    if (process.argv.includes("--members")) {
      await (
        await import("./member-directory-browser")
      ).verifyMemberDirectoryBrowser(app, access);
    } else if (process.argv.includes("--editing")) {
      await command(2, "create", {
        key: randomUUID(),
        unitId: access.accounts[2].unitId,
        title: "Synthetic browser editable task",
        description: "Original synthetic instructions",
        roleLabel: "Participant",
        priority: "normal",
        capacity: 3,
        deadline: new Date(Date.now() + 86400000).toISOString(),
        contributionRuleId: null,
      });
      await (
        await import("./work-editing-browser")
      ).verifyWorkEditingBrowser(app, access);
    } else if (process.argv.includes("--recognition")) {
      const id = (
        await command(2, "create", {
          key: randomUUID(),
          unitId: access.accounts[2].unitId,
          title: "Synthetic browser verified bonus",
          roleLabel: "Volunteer",
          priority: "normal",
          capacity: 1,
          deadline: new Date(Date.now() + 86400000).toISOString(),
          contributionRuleId: null,
        })
      ).id;
      await act(3, "apply", id);
      await act(2, "assign", id, { memberId: access.accounts[3].memberId });
      await act(3, "start", id);
      await act(3, "submit", id);
      await act(0, "verify", id, { memberId: access.accounts[3].memberId });
      await (
        await import("./work-recognition-browser")
      ).verifyWorkRecognitionBrowser(app, access);
    } else if (process.argv.includes("--events")) {
      await (await import("./events-browser")).verifyEventsBrowser(app, access);
    } else if (process.argv.includes("--review-hierarchy")) {
      const id = (
        await command(2, "create", {
          key: randomUUID(),
          unitId: access.accounts[2].unitId,
          title: "Synthetic browser hierarchy confirmation",
          description: "Independent upper-level completion review",
          roleLabel: "Participant",
          priority: "normal",
          capacity: 1,
          deadline: new Date(Date.now() + 86400000).toISOString(),
          contributionRuleId: null,
        })
      ).id;
      await act(2, "apply", id);
      await act(3, "assign", id, { memberId: access.accounts[2].memberId });
      await act(2, "start", id);
      await act(2, "submit", id);
      await (
        await import("./work-review-browser")
      ).verifyWorkReviewBrowser(app, access, id);
    } else {
      const verifyMobilizationBrowser = process.argv.includes("--materials")
        ? (await import("./work-materials-browser")).verifyWorkMaterialsBrowser
        : (await import("./mobilization-browser")).verifyMobilizationBrowser;
      await verifyMobilizationBrowser(app, access);
    }
  }
  console.log(`${checks} mobilization scenarios passed`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
