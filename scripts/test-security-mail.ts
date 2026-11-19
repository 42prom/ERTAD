import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_delivery_${randomBytes(8).toString("hex")}`,
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
  console.log("PASS " + name);
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
    { enableDemoInvitations } = await import("./web-demo-invitations");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await enableDemoInvitations(owner, access);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { collectiveCommand } =
    await import("../backend/src/modules/governance/collective");
  const { invitationCommand } =
    await import("../backend/src/modules/identity/invitations");
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
  const cmd = (
    i: number,
    op: Parameters<typeof collectiveCommand>[1],
    input: object = {},
  ) => collectiveCommand(sessions[i], op, { organizationId: org, ...input });
  const invite = (
    i: number,
    op: Parameters<typeof invitationCommand>[1],
    input: object = {},
  ) =>
    invitationCommand(
      sessions[i],
      op,
      op === "contexts" ? {} : { organizationId: org, ...input },
    );
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(
      promise,
      (e: unknown) => (e as { statusCode: number }).statusCode === status,
    );
  async function contact(unit = a) {
    const member = randomUUID(),
      id = randomUUID(),
      email = `recipient-${randomBytes(8).toString("hex")}@example.invalid`;
    const position = (
      await owner.query(
        "SELECT id FROM positions WHERE organization_id=$1 AND unit_id=$2 AND name='Invitation recipient demo'",
        [org, unit],
      )
    ).rows[0].id;
    await owner.query("INSERT INTO member_users(id) VALUES($1)", [member]);
    await owner.query(
      "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now()-interval '1 minute',now()+interval '30 days')",
      [org, member, unit, position],
    );
    await owner.query(
      "INSERT INTO organization_member_labels(organization_id,member_id,display_name) VALUES($1,$2,'Synthetic invitation recipient')",
      [org, member],
    );
    await owner.query(
      "INSERT INTO web_invite_contacts(organization_id,id,unit_id,member_id,email,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
      [org, id, unit, member, email],
    );
    return { id, member, email, unit };
  }
  const payload = (c: { id: string; unit: string }) => ({
    key: randomUUID(),
    unitId: c.unit,
    kind: "account_invite",
    parameters: { contactId: c.id },
    reason: "Synthetic recipient activation",
    deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  const vote = (id: string) => ({
    id,
    version: 1,
    key: randomUUID(),
    choice: "approve",
    reason: "Independent synthetic review",
  });
  await (
    await import("./security-mail-cases")
  ).verifySecurityMail({
    owner,
    db,
    app,
    access,
    sessions,
    org,
    a,
    b,
    contact,
    cmd,
    invite,
    payload,
    vote,
    denied,
    check,
  });
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created)
    await control.query("DROP DATABASE " + database + " WITH (FORCE)");
  await control.end();
}
