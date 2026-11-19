import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";
loadEnvFile(".env");
const database = `ertad_platform_test_${randomBytes(8).toString("hex")}`,
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
  count = 0;
const origin = "http://localhost:15173",
  base = "/api/v1/admin";
const check = async (name: string, fn: () => Promise<void>) => {
  await fn();
  count++;
  console.log(`PASS ${name}`);
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
  const { seedPlatformOperator } = await import("./platform-fixture"),
    { seedWebDemo } = await import("./web-demo-fixture");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner),
    technical = await seedPlatformOperator(owner);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin"),
    { platformCommand, platformDependencies } =
      await import("../backend/src/modules/security/platform"),
    { SecurityService } = await import("../backend/src/services/security");
  let probes = 0;
  const checks = {
    postgres: async () => {
      probes++;
    },
    redis: async () => {},
    storage: async () => {},
  };
  const savedTechnical = {
    ...technical,
    validUntil: new Date(technical.validUntil).toISOString(),
  };
  let platformFixture: unknown = savedTechnical;
  const app = createApp(
    checks,
    pino({ level: "silent" }),
    origin,
    createLocalAdminRouter(
      origin,
      () => access,
      () => platformFixture,
    ),
  );
  const tech = request.agent(app),
    council = request.agent(app);
  await tech
    .post(base + "/auth/login")
    .set("Origin", origin)
    .send({ email: technical.email, password: technical.password })
    .expect(200);
  await council
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: access.accounts[0].id })
    .expect(200);
  const session = (
    await owner.query(
      'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1',
      [technical.id],
    )
  ).rows[0];
  const command = (op: "access" | "overview" | "audit", input = {}) =>
    platformCommand(session, op, input);
  const denied = (p: Promise<unknown>) =>
    assert.rejects(p, (e: any) => e.statusCode === 403);
  await check(
    "technical capability is independent of role and organizational rank",
    async () => {
      await request(app)
        .get(base + "/platform/overview")
        .expect(401);
      await request(app)
        .get(base + "/platform/overview")
        .set("Authorization", "Bearer invalid-mobile-token")
        .set("X-Admin-Role", "superadmin")
        .expect(401);
      const deniedAccess = await council
        .get(base + "/platform/access")
        .expect(200);
      assert.equal(deniedAccess.body.technicalAccount, false);
      await council.get(base + "/platform/overview").expect(403);
      await council.get(base + "/platform/audit").expect(403);
      assert.equal(probes, 0);
      const response = await tech
        .get(base + "/platform/overview")
        .expect("Cache-Control", "no-store")
        .expect(200);
      assert.equal(response.body.migrations, 69);
      assert.equal(response.body.ownActiveSessions, 1);
      assert.equal(response.body.productionEnabled, false);
      assert.equal(response.body.dependencies.postgres, "ready");
      assert.equal(
        (
          await owner.query("SELECT role FROM admin_users WHERE id=$1", [
            technical.id,
          ])
        ).rows[0].role,
        "observer",
      );
    },
  );
  await check(
    "technical account cannot read or mutate organizational modules or activate legacy settings",
    async () => {
      for (const path of [
        "/reviews/contexts",
        "/units/contexts",
        "/members/contexts",
        "/work/contexts",
        "/decisions/contexts",
        "/collective/contexts",
        "/channels/contexts",
        "/inbox/summary",
        "/settings/security",
        "/admin-users",
      ])
        await tech.get(base + path).expect(403);
      await tech
        .post(base + "/work/create")
        .set("Origin", origin)
        .send({ organizationId: access.organizationId })
        .expect(403);
      await tech
        .post(base + "/platform/grant")
        .set("Origin", origin)
        .send({ permissions: ["platform.read"] })
        .expect(403);
    },
  );
  await check(
    "account separation is persistent in both directions and runtime cannot grant itself access",
    async () => {
      for (const sql of [
        "SELECT * FROM platform_accounts",
        `UPDATE platform_accounts SET valid_until=now()+interval '1 year'`,
        `DELETE FROM platform_accounts`,
      ])
        await assert.rejects(
          db.pool.query(sql),
          (e: any) => e.code === "42501",
        );
      await assert.rejects(
        owner.query("INSERT INTO member_users(web_account_id) VALUES($1)", [
          technical.id,
        ]),
        (e: any) => e.code === "23514",
      );
      await assert.rejects(
        owner.query("UPDATE member_users SET web_account_id=$1 WHERE id=$2", [
          technical.id,
          access.accounts[0].memberId,
        ]),
        (e: any) => e.code === "23514",
      );
      await assert.rejects(
        owner.query(
          "INSERT INTO platform_accounts(admin_user_id,permissions,valid_until) VALUES($1,'{}',now()+interval '1 day')",
          [access.accounts[0].id],
        ),
        (e: any) => e.code === "23514",
      );
      await assert.rejects(
        owner.query("DELETE FROM platform_accounts WHERE admin_user_id=$1", [
          technical.id,
        ]),
        (e: any) => e.code === "23514",
      );
    },
  );
  await check(
    "concurrent classification cannot attach an organization member to a technical account",
    async () => {
      const contender = new pg.Client({
        ...config,
        database,
        options: "-c search_path=ertad,public",
        statement_timeout: 5000,
      });
      await contender.connect();
      try {
        for (const technicalFirst of [true, false]) {
          const id = (
            await owner.query(
              `INSERT INTO admin_users(email,password_hash,role,mfa_secret_encrypted)
          SELECT $1,password_hash,'observer',mfa_secret_encrypted FROM admin_users WHERE id=$2 RETURNING id`,
              [`race-${technicalFirst}@example.invalid`, technical.id],
            )
          ).rows[0].id;
          const technicalSql =
            "INSERT INTO platform_accounts(admin_user_id,permissions,valid_until) VALUES($1,'{}',now()+interval '1 day')";
          const memberSql =
            "INSERT INTO member_users(web_account_id) VALUES($1)";
          await owner.query("BEGIN");
          await owner.query(technicalFirst ? technicalSql : memberSql, [id]);
          const racing = contender
            .query(technicalFirst ? memberSql : technicalSql, [id])
            .then(
              () => null,
              (e) => e.code,
            );
          await new Promise((r) => setTimeout(r, 100));
          await owner.query("COMMIT");
          assert.equal(await racing, "23514");
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int n FROM platform_accounts p JOIN member_users m ON m.web_account_id=p.admin_user_id WHERE p.admin_user_id=$1",
                [id],
              )
            ).rows[0].n,
            0,
          );
        }
      } finally {
        await owner.query("ROLLBACK");
        await contender.end();
      }
    },
  );
  await check(
    "sanitized technical audit excludes organization events and payload fields; keyset pagination is bounded",
    async () => {
      await owner.query("BEGIN");
      for (let i = 0; i < 30; i++)
        await SecurityService.logAuditEventInTransaction(
          owner,
          "ADMIN_LOGIN_SUCCEEDED",
          {
            adminUserId: technical.id,
            secret: "synthetic-never-disclose",
            email: "hidden@example.invalid",
          },
        );
      await SecurityService.logAuditEventInTransaction(
        owner,
        "ADMIN_LOGIN_SUCCEEDED",
        { adminUserId: access.accounts[0].id, secret: "organization-event" },
      );
      await SecurityService.logAuditEventInTransaction(
        owner,
        "PRIVATE_ORGANIZATION_EVENT",
        { adminUserId: technical.id, secret: "organization-event" },
      );
      await owner.query("COMMIT");
      const first = await command("audit", { category: "authentication" }),
        second = await command("audit", {
          category: "authentication",
          before: first.nextBefore,
        });
      assert.equal(first.items.length, 25);
      assert.ok(first.nextBefore);
      assert.equal(second.items.length, 6);
      assert.equal(second.nextBefore, null);
      for (const entry of [...first.items, ...second.items])
        assert.deepEqual(Object.keys(entry).sort(), ["at", "event", "id"]);
      const serialized = JSON.stringify(first);
      for (const forbidden of [
        "synthetic-never-disclose",
        "hidden@example.invalid",
        technical.id,
        access.accounts[0].id,
        "organization-event",
      ])
        assert.ok(!serialized.includes(forbidden));
      assert.equal(
        new Set([...first.items, ...second.items].map((i) => i.id)).size,
        31,
      );
      await tech
        .get(base + "/platform/audit")
        .query({ before: "9223372036854775808" })
        .expect(400);
      await tech
        .get(base + "/platform/audit")
        .query({ limit: 1000 })
        .expect(400);
      await tech
        .get(base + "/platform/overview")
        .query({ organizationId: access.organizationId })
        .expect(400);
    },
  );
  await check(
    "audit capability can be withheld independently and expired/revoked grants fail closed",
    async () => {
      await owner.query(
        "UPDATE platform_accounts SET permissions=ARRAY['platform.read'] WHERE admin_user_id=$1",
        [technical.id],
      );
      await command("overview");
      await denied(command("audit"));
      await owner.query(
        "UPDATE platform_accounts SET permissions=ARRAY['platform.read','platform.audit.read'],revoked_at=now() WHERE admin_user_id=$1",
        [technical.id],
      );
      const access = await command("access");
      assert.equal(access.technicalAccount, true);
      assert.deepEqual(access.permissions, []);
      await denied(command("overview"));
      await assert.rejects(
        owner.query("INSERT INTO member_users(web_account_id) VALUES($1)", [
          technical.id,
        ]),
        (e: any) => e.code === "23514",
      );
      await owner.query(
        "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
        [technical.id],
      );
    },
  );
  await check(
    "required audit failure and grant expiry during audit prevent disclosure",
    async () => {
      const original = SecurityService.logAuditEventInTransaction;
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw new Error("synthetic audit failure");
        };
        await assert.rejects(command("overview"), /synthetic audit failure/);
        await owner.query(
          "UPDATE platform_accounts SET valid_until=clock_timestamp()+interval '2 seconds' WHERE admin_user_id=$1",
          [technical.id],
        );
        SecurityService.logAuditEventInTransaction = async (...args) => {
          await original(...args);
          await new Promise((r) => setTimeout(r, 2200));
        };
        await denied(command("overview"));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query(
          "UPDATE platform_accounts SET valid_until=now()+interval '90 days' WHERE admin_user_id=$1",
          [technical.id],
        );
      }
    },
  );
  await check(
    "slow/degraded probes are sanitized and current authority is rechecked afterwards",
    async () => {
      assert.deepEqual(
        await platformDependencies({
          postgres: async () => {},
          redis: async () => {
            throw new Error("secret connection string");
          },
          storage: () => new Promise(() => {}),
        }),
        { postgres: "ready", redis: "unavailable", storage: "unavailable" },
      );
      app.locals.dependencyChecks = {
        ...checks,
        redis: async () => {
          await owner.query(
            "UPDATE platform_accounts SET revoked_at=now() WHERE admin_user_id=$1",
            [technical.id],
          );
        },
      };
      try {
        await tech.get(base + "/platform/overview").expect(403);
      } finally {
        app.locals.dependencyChecks = checks;
        await owner.query(
          "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
          [technical.id],
        );
      }
    },
  );
  await check(
    "session revocation and account suspension also deny SQL disclosure",
    async () => {
      await owner.query("UPDATE admin_users SET is_active=false WHERE id=$1", [
        technical.id,
      ]);
      await denied(command("overview"));
      await owner.query("UPDATE admin_users SET is_active=true WHERE id=$1", [
        technical.id,
      ]);
      await owner.query(
        "UPDATE admin_sessions SET revoked_at=now() WHERE id=$1",
        [session.sessionId],
      );
      await denied(command("overview"));
      await tech.get(base + "/platform/overview").expect(401);
    },
  );
  await check(
    "technical quick login uses only its fixture and real password without granting or renewing permissions",
    async () => {
      const listed = await request(app)
        .get(base + "/demo/accounts")
        .expect(200);
      assert.equal(listed.body.accounts.length, 7);
      const last = listed.body.accounts[6];
      assert.equal(last.id, technical.id);
      assert.equal(last.kind, "technical");
      assert.deepEqual(Object.keys(last).sort(), [
        "email",
        "id",
        "kind",
        "label",
        "region",
      ]);
      for (const account of [...access.accounts, technical])
        assert.ok(!JSON.stringify(listed.body).includes(account.password));
      await request(app)
        .get(base + "/demo/accounts")
        .set("Host", "attacker.invalid")
        .expect(403);
      await request(app)
        .post(base + "/demo/login")
        .send({ accountId: technical.id })
        .expect(403);
      await request(app)
        .post(base + "/demo/login")
        .set("Origin", "https://attacker.invalid")
        .send({ accountId: technical.id })
        .expect(403);
      await request(app)
        .post(base + "/demo/login")
        .set("Origin", origin)
        .send({ accountId: technical.id, role: "superadmin" })
        .expect(400);
      const fast = request.agent(app);
      const login = await fast
        .post(base + "/demo/login")
        .set("Origin", origin)
        .send({ accountId: technical.id })
        .expect(200);
      assert.ok(login.body.csrfToken);
      assert.ok(login.headers["set-cookie"]);
      assert.equal(login.body.user.id, technical.id);
      await fast.get(base + "/platform/overview").expect(200);
      await fast.get(base + "/members/contexts").expect(403);
      await fast
        .post(base + "/demo/step-up")
        .set("Origin", origin)
        .set("X-Admin-Csrf", login.body.csrfToken)
        .send({})
        .expect(403);
      try {
        platformFixture = null;
        assert.equal(
          (
            await request(app)
              .get(base + "/demo/accounts")
              .expect(200)
          ).body.accounts.length,
          6,
        );
        await request(app)
          .post(base + "/demo/login")
          .set("Origin", origin)
          .send({ accountId: technical.id })
          .expect(403);
        platformFixture = { ...savedTechnical, id: access.accounts[0].id };
        assert.equal(
          (
            await request(app)
              .get(base + "/demo/accounts")
              .expect(200)
          ).body.accounts.length,
          6,
        );
        platformFixture = {
          ...savedTechnical,
          password: randomBytes(24).toString("base64url"),
        };
        await request(app)
          .post(base + "/demo/login")
          .set("Origin", origin)
          .send({ accountId: technical.id })
          .expect(401);
        platformFixture = {
          ...savedTechnical,
          email: access.accounts[0].email,
        };
        assert.equal(
          (
            await request(app)
              .get(base + "/demo/accounts")
              .expect(200)
          ).body.accounts.length,
          6,
        );
        platformFixture = savedTechnical;
        await owner.query(
          "UPDATE platform_accounts SET revoked_at=now() WHERE admin_user_id=$1",
          [technical.id],
        );
        const before = (
          await owner.query(
            "SELECT to_jsonb(p) data FROM platform_accounts p WHERE admin_user_id=$1",
            [technical.id],
          )
        ).rows[0].data;
        await fast
          .post(base + "/demo/login")
          .set("Origin", origin)
          .send({ accountId: technical.id })
          .expect(200);
        await fast.get(base + "/platform/overview").expect(403);
        assert.deepEqual(
          (
            await owner.query(
              "SELECT to_jsonb(p) data FROM platform_accounts p WHERE admin_user_id=$1",
              [technical.id],
            )
          ).rows[0].data,
          before,
        );
      } finally {
        platformFixture = savedTechnical;
        await owner.query(
          "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
          [technical.id],
        );
      }
      await owner.query("UPDATE admin_users SET is_active=false WHERE id=$1", [
        technical.id,
      ]);
      try {
        await request(app)
          .post(base + "/demo/login")
          .set("Origin", origin)
          .send({ accountId: technical.id })
          .expect(403);
      } finally {
        await owner.query("UPDATE admin_users SET is_active=true WHERE id=$1", [
          technical.id,
        ]);
      }
    },
  );
  await (
    await import("./platform-session-tests")
  ).testPlatformSessions(app, owner, technical, access.accounts[0].id, check);
  await (
    await import("./platform-integration-tests")
  ).testPlatformIntegrations(
    app,
    owner,
    technical,
    access.accounts[0].id,
    check,
  );
  const policyReviewer = await (
    await import("./platform-policy-tests")
  ).testPlatformPolicy(app, owner, technical, access.accounts[0].id, check);
  await (
    await import("./platform-monitoring-tests")
  ).testPlatformMonitoring(app, owner, technical, access.accounts[0].id, check);
  if (process.argv.includes("--browser"))
    await (
      await import("./platform-browser")
    ).verifyPlatformBrowser(
      app,
      technical,
      {
        email: access.accounts[1].email,
        sessionId: async () =>
          (
            await owner.query(
              "SELECT id FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
              [access.accounts[1].id],
            )
          ).rows[0].id,
      },
      policyReviewer,
    );
  console.log(`${count} platform scenarios passed`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
