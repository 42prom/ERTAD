import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  unlink,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

loadEnvFile(".env");
const database = `ertad_recovery_${randomBytes(8).toString("hex")}`,
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
  base = "/api/v1/admin",
  password = "Synthetic-invitation-pass-582!";
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
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
  const { invitationCommand, activateInvitation } =
    await import("../backend/src/modules/identity/invitations");
  const { SecurityService } = await import("../backend/src/services/security");
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
  async function approved() {
    const c = await contact(),
      input = payload(c),
      p = await cmd(2, "propose", input);
    await cmd(3, "vote", vote(p.id));
    return { ...c, invite: p.id };
  }
  async function delivered() {
    const c = await approved(),
      token = randomBytes(32).toString("base64url");
    await owner.query("SELECT web_invite_delivery($1,$2)", [
      c.invite,
      digest(token),
    ]);
    return { ...c, token };
  }
  const activate = (c: { invite: string; token: string }) =>
    activateInvitation({ id: c.invite, token: c.token, password });
  const count = async (table: string) =>
    (await owner.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;

  const { requestRecovery, completeRecovery } =
    await import("../backend/src/modules/identity/recovery");
  const { deliverSyntheticCredential } = await import("./invitation-delivery");
  const recoveredPassword = "Synthetic-recovered-pass-948!";
  async function recipient() {
    const c = await delivered();
    await activate(c);
    const account = (
      await owner.query("SELECT account_id FROM web_invitations WHERE id=$1", [
        c.invite,
      ])
    ).rows[0].account_id;
    return { ...c, account };
  }
  async function pending(c: Awaited<ReturnType<typeof recipient>>) {
    await requestRecovery({ email: c.email });
    const row = (
      await owner.query(
        "SELECT * FROM web_account_recoveries WHERE account_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL",
        [c.account],
      )
    ).rows[0];
    assert.ok(row);
    return row;
  }
  async function ready() {
    const c = await recipient(),
      row = await pending(c),
      token = randomBytes(32).toString("base64url");
    await owner.query("SELECT web_recovery_delivery($1,$2)", [
      row.id,
      digest(token),
    ]);
    return { ...c, recovery: row.id, recoveryToken: token };
  }
  const reset = (
    c: Awaited<ReturnType<typeof ready>>,
    value = recoveredPassword,
  ) =>
    completeRecovery({
      id: c.recovery,
      token: c.recoveryToken,
      password: value,
    });
  const snapshot = async (account: string) =>
    (
      await owner.query(
        "SELECT password_hash,password_changed_at,mfa_enabled,mfa_secret_encrypted,role,is_active,locked_until FROM admin_users WHERE id=$1",
        [account],
      )
    ).rows[0];

  await check(
    "public requests are generic, strict, Origin-protected and rate-limit successful requests",
    async () => {
      const c = await recipient();
      await request(app)
        .post(base + "/recovery/request")
        .send({ email: c.email })
        .expect(403);
      const send = (body: object) =>
        request(app)
          .post(base + "/recovery/request")
          .set("Origin", origin)
          .send(body);
      const unknown = await send({ email: "unknown@example.invalid" }).expect(
        200,
      );
      const known = await send({ email: c.email }).expect(200);
      assert.deepEqual(unknown.body, { accepted: true });
      assert.deepEqual(known.body, unknown.body);
      await send({ email: c.email, accountId: c.account }).expect(400);
      await send({ email: "another@example.invalid" }).expect(200);
      await send({ email: c.email }).expect(200);
      await send({ email: c.email }).expect(429);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM web_account_recoveries WHERE account_id=$1",
            [c.account],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    "repeated requests preserve the pending token and original deadline",
    async () => {
      const c = await ready();
      const before = (
        await owner.query("SELECT * FROM web_account_recoveries WHERE id=$1", [
          c.recovery,
        ])
      ).rows[0];
      await requestRecovery({ email: c.email.toUpperCase() });
      assert.deepEqual(
        (
          await owner.query(
            "SELECT * FROM web_account_recoveries WHERE id=$1",
            [c.recovery],
          )
        ).rows[0],
        before,
      );
      await assert.rejects(
        owner.query("SELECT web_recovery_delivery($1,$2)", [
          c.recovery,
          digest("replacement"),
        ]),
        (e: unknown) => (e as { code: string }).code === "P0409",
      );
    },
  );
  await check(
    "explicit recovery changes only credentials, closes every session and requires normal login",
    async () => {
      const c = await ready(),
        before = await snapshot(c.account),
        memberships = await count("memberships"),
        grants = await count("permission_grants");
      const agent = request.agent(app);
      await agent
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: c.email, password })
        .expect(200);
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: c.email, password })
        .expect(200);
      await denied(reset(c, password), 400);
      await reset(c);
      await agent.get(base + "/auth/me").expect(401);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND (revoked_at IS NULL OR step_up_expires_at IS NOT NULL)",
            [c.account],
          )
        ).rows[0].n,
        0,
      );
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: c.email, password })
        .expect(401);
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: c.email, password: recoveredPassword })
        .expect(200);
      const after = await snapshot(c.account);
      assert.notEqual(after.password_hash, before.password_hash);
      for (const key of [
        "role",
        "mfa_enabled",
        "mfa_secret_encrypted",
        "is_active",
        "locked_until",
      ])
        assert.deepEqual(after[key], before[key]);
      assert.equal(await count("memberships"), memberships);
      assert.equal(await count("permission_grants"), grants);
      await denied(reset(c), 409);
    },
  );
  await check("concurrent consumption has exactly one winner", async () => {
    const c = await ready();
    const result = await Promise.allSettled([reset(c), reset(c)]);
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  });
  await check(
    "expiry, token mismatch and revocation fail without password changes",
    async () => {
      for (const state of ["wrong", "expired", "revoked"]) {
        const c = await ready(),
          before = await snapshot(c.account);
        if (state === "wrong")
          c.recoveryToken = randomBytes(32).toString("base64url");
        else if (state === "expired")
          await owner.query(
            "UPDATE web_account_recoveries SET created_at=now()-interval '31 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",
            [c.recovery],
          );
        else
          await owner.query(
            "UPDATE web_account_recoveries SET revoked_at=now() WHERE id=$1",
            [c.recovery],
          );
        await denied(reset(c), 409);
        assert.deepEqual(await snapshot(c.account), before);
      }
    },
  );
  await check(
    "inactive members/accounts, lockout, changed destination and provisioned MFA cannot be bypassed",
    async () => {
      for (const state of [
        "member",
        "account",
        "lockout",
        "contact",
        "email",
        "mfa",
      ]) {
        const c = await ready();
        if (state === "member")
          await owner.query(
            "UPDATE member_users SET status='suspended' WHERE id=$1",
            [c.member],
          );
        if (state === "account")
          await owner.query(
            "UPDATE admin_users SET is_active=false WHERE id=$1",
            [c.account],
          );
        if (state === "lockout")
          await owner.query(
            "UPDATE admin_users SET locked_until=now()+interval '1 hour' WHERE id=$1",
            [c.account],
          );
        if (state === "contact")
          await owner.query(
            "UPDATE web_invite_contacts SET revoked_at=now() WHERE id=$1",
            [c.id],
          );
        if (state === "email")
          await owner.query(
            "UPDATE admin_users SET email='changed-'||id||'@example.invalid' WHERE id=$1",
            [c.account],
          );
        if (state === "mfa")
          await owner.query(
            "UPDATE admin_users SET mfa_secret_encrypted=$2 WHERE id=$1",
            [
              c.account,
              (
                await import("../backend/src/services/secretEncryption")
              ).encryptSensitiveValue("synthetic-pending-proof"),
            ],
          );
        const before = await snapshot(c.account);
        await denied(reset(c), 409);
        assert.deepEqual(await snapshot(c.account), before);
        assert.deepEqual(await requestRecovery({ email: c.email }), {
          accepted: true,
        });
      }
    },
  );
  await check(
    "intervening password rotation invalidates the token; a new request cannot revive it",
    async () => {
      const c = await ready();
      const { hashAdminPassword } =
        await import("../backend/src/services/adminPassword");
      const hash = await hashAdminPassword(
        "Synthetic-intervening-password-249!",
      );
      await owner.query("UPDATE admin_users SET password_hash=$2 WHERE id=$1", [
        c.account,
        hash,
      ]);
      await denied(reset(c), 409);
      const next = await pending(c);
      assert.notEqual(next.id, c.recovery);
      await denied(reset(c), 409);
    },
  );
  await check(
    "audit outage and post-audit lockout roll back credential consumption",
    async () => {
      const c = await ready(),
        before = await snapshot(c.account),
        original = SecurityService.logAuditEventInTransaction;
      await owner.query(
        `CREATE FUNCTION ertad.test_recovery_tamper(account uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ UPDATE ertad.admin_users SET locked_until=clock_timestamp()+interval '1 hour' WHERE id=account $$`,
      );
      await owner.query(
        "REVOKE ALL ON FUNCTION ertad.test_recovery_tamper(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION ertad.test_recovery_tamper(uuid) TO ertad_app",
      );
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw new Error("synthetic audit failure");
        };
        await assert.rejects(reset(c), /synthetic audit failure/);
        assert.deepEqual(await snapshot(c.account), before);
        SecurityService.logAuditEventInTransaction = async (
          client,
          ...args
        ) => {
          await original(client, ...args);
          await client.query("SELECT ertad.test_recovery_tamper($1)", [
            c.account,
          ]);
        };
        await denied(reset(c), 409);
        assert.deepEqual(await snapshot(c.account), before);
        assert.equal(
          (
            await owner.query(
              "SELECT consumed_at FROM web_account_recoveries WHERE id=$1",
              [c.recovery],
            )
          ).rows[0].consumed_at,
          null,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query("DROP FUNCTION ertad.test_recovery_tamper(uuid)");
      }
    },
  );
  await check("request audit failure leaves no pending recovery", async () => {
    const c = await recipient(),
      original = SecurityService.logAuditEventInTransaction;
    try {
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("synthetic request audit failure");
      };
      await assert.rejects(
        requestRecovery({ email: c.email }),
        /synthetic request audit failure/,
      );
    } finally {
      SecurityService.logAuditEventInTransaction = original;
    }
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int n FROM web_account_recoveries WHERE account_id=$1",
          [c.account],
        )
      ).rows[0].n,
      0,
    );
  });
  await check(
    "actual local mailbox keeps credentials private and does not overwrite an issued token",
    async () => {
      const c = await recipient(),
        row = await pending(c),
        directory = await mkdtemp(resolve(".local/recovery-test-"));
      try {
        await deliverSyntheticCredential(
          owner,
          row.id,
          directory,
          origin,
          "recovery",
        );
        const message = JSON.parse(
          await readFile(resolve(directory, row.id + ".json"), "utf8"),
        );
        assert.equal(message.to, c.email);
        assert.equal(new URL(message.url).pathname, "/recover");
        const token = new URL(message.url).hash.split(".")[1];
        await assert.rejects(
          deliverSyntheticCredential(
            owner,
            row.id,
            directory,
            origin,
            "recovery",
          ),
        );
        assert.equal(
          JSON.parse(
            await readFile(resolve(directory, row.id + ".json"), "utf8"),
          ).url,
          message.url,
        );
        await completeRecovery({
          id: row.id,
          token,
          password: recoveredPassword,
        });
      } finally {
        for (const name of await readdir(directory))
          await unlink(resolve(directory, name));
        await rmdir(directory);
      }
    },
  );
  await check(
    "runtime cannot read recovery records or invoke delivery/eligibility helpers",
    async () => {
      const runtime = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await runtime.connect();
      try {
        for (const sql of [
          "SELECT * FROM ertad.web_account_recoveries",
          "SELECT ertad.web_recovery_delivery(gen_random_uuid(),repeat('a',64))",
          "SELECT ertad.web_recovery_eligible(gen_random_uuid(),gen_random_uuid(),gen_random_uuid())",
        ])
          await assert.rejects(
            runtime.query(sql),
            (e: unknown) => (e as { code: string }).code === "42501",
          );
      } finally {
        await runtime.end();
      }
    },
  );
  const { selfAccountCommand } =
    await import("../backend/src/modules/identity/selfAccount");
  async function ownLogin(c: Awaited<ReturnType<typeof recipient>>) {
    const agent = request.agent(app);
    const login = await agent
      .post(base + "/auth/login")
      .set("Origin", origin)
      .send({ email: c.email, password })
      .expect(200);
    const identity = (
      await owner.query(
        'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
        [c.account],
      )
    ).rows[0];
    const post = (path: string, body: object) =>
      agent
        .post(base + "/auth/" + path)
        .set("Origin", origin)
        .set("X-Admin-Csrf", login.body.csrfToken)
        .send(body);
    return {
      agent,
      identity,
      post,
      stepUp: () => post("step-up", { password }).expect(200),
    };
  }
  await check(
    "own recovery HTTP projection, Origin/CSRF/step-up gates and no account selectors",
    async () => {
      const c = await ready(),
        s = await ownLogin(c);
      const response = await s.agent
        .get(base + "/auth/security/recovery")
        .expect(200);
      assert.match(response.headers["cache-control"], /no-store/);
      assert.equal(response.body.available, true);
      assert.deepEqual(Object.keys(response.body.pending).sort(), [
        "createdAt",
        "delivered",
        "expiresAt",
        "id",
      ]);
      assert.equal(response.body.pending.id, c.recovery);
      assert.equal(response.body.pending.delivered, true);
      await s.agent
        .get(base + "/auth/security/recovery?accountId=" + c.account)
        .expect(400);
      await request(app)
        .get(base + "/auth/security/recovery")
        .expect(401);
      await s.agent
        .post(base + "/auth/security/recovery/cancel")
        .send({ recoveryId: c.recovery })
        .expect(403);
      await s.agent
        .post(base + "/auth/security/recovery/cancel")
        .set("Origin", origin)
        .send({ recoveryId: c.recovery })
        .expect(403);
      await s
        .post("security/recovery/cancel", { recoveryId: c.recovery })
        .expect(428);
      await s.stepUp();
      await s
        .post("security/recovery/cancel", {
          recoveryId: c.recovery,
          accountId: c.account,
        })
        .expect(400);
      const before = await snapshot(c.account),
        grants = await count("permission_grants");
      await s
        .post("security/recovery/cancel", { recoveryId: c.recovery })
        .expect(200);
      await denied(reset(c), 409);
      assert.deepEqual(await snapshot(c.account), before);
      assert.equal(await count("permission_grants"), grants);
      await s.agent.get(base + "/auth/security/sessions").expect(200);
      assert.equal(
        (await s.agent.get(base + "/auth/security/recovery").expect(200)).body
          .pending,
        null,
      );
    },
  );
  await check(
    "cross-account denial and exact retries never cancel a replacement request",
    async () => {
      const c = await ready(),
        other = await ready(),
        s = await ownLogin(c);
      await s.stepUp();
      await denied(
        selfAccountCommand(s.identity, "cancelRecovery", {
          recoveryId: other.recovery,
        }),
        409,
      );
      await denied(
        selfAccountCommand(s.identity, "cancelRecovery", {
          recoveryId: randomUUID(),
        }),
        409,
      );
      const action = () =>
        selfAccountCommand(s.identity, "cancelRecovery", {
          recoveryId: c.recovery,
        });
      await Promise.all([action(), action()]);
      const row = await pending(c);
      assert.notEqual(row.id, c.recovery);
      await action();
      const current = (await selfAccountCommand(
        s.identity,
        "recovery",
        {},
      )) as { pending: { id: string; delivered: boolean } };
      assert.equal(current.pending.id, row.id);
      assert.equal(current.pending.delivered, false);
      await reset(other); // Other account's token remains usable.
    },
  );
  await check(
    "cancellation audit outage and post-audit tampering roll back",
    async () => {
      const c = await ready(),
        s = await ownLogin(c);
      await s.stepUp();
      const original = SecurityService.logAuditEventInTransaction;
      await owner.query(
        `CREATE FUNCTION ertad.test_uncancel_recovery(target uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ UPDATE ertad.web_account_recoveries SET revoked_at=NULL WHERE id=target $$`,
      );
      await owner.query(
        "REVOKE ALL ON FUNCTION ertad.test_uncancel_recovery(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION ertad.test_uncancel_recovery(uuid) TO ertad_app",
      );
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw new Error("synthetic cancellation audit failure");
        };
        await assert.rejects(
          selfAccountCommand(s.identity, "cancelRecovery", {
            recoveryId: c.recovery,
          }),
          /synthetic cancellation audit failure/,
        );
        SecurityService.logAuditEventInTransaction = async (
          client,
          ...args
        ) => {
          await original(client, ...args);
          await client.query("SELECT ertad.test_uncancel_recovery($1)", [
            c.recovery,
          ]);
        };
        await denied(
          selfAccountCommand(s.identity, "cancelRecovery", {
            recoveryId: c.recovery,
          }),
          409,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT revoked_at FROM web_account_recoveries WHERE id=$1",
              [c.recovery],
            )
          ).rows[0].revoked_at,
          null,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query("DROP FUNCTION ertad.test_uncancel_recovery(uuid)");
      }
      await reset(c);
    },
  );
  await check(
    "cancel versus consume is serialized with no usable cancelled token",
    async () => {
      const c = await ready(),
        s = await ownLogin(c);
      await s.stepUp();
      const result = await Promise.allSettled([
        selfAccountCommand(s.identity, "cancelRecovery", {
          recoveryId: c.recovery,
        }),
        reset(c),
      ]);
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
      const row = (
        await owner.query(
          "SELECT revoked_at,consumed_at FROM web_account_recoveries WHERE id=$1",
          [c.recovery],
        )
      ).rows[0];
      assert.ok(Boolean(row.revoked_at) !== Boolean(row.consumed_at));
      await denied(reset(c), 409);
    },
  );
  await check(
    "own recovery SQL enforces session and fresh proof without table privileges",
    async () => {
      const c = await ready(),
        s = await ownLogin(c);
      const runtime = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await runtime.connect();
      try {
        const sql = "SELECT ertad.own_web_recovery($1,$2,$3,$4)";
        await assert.rejects(
          runtime.query(sql, [
            s.identity.sessionId,
            "wrong-token",
            "read",
            null,
          ]),
          (e: unknown) => (e as { code: string }).code === "42501",
        );
        await assert.rejects(
          runtime.query(sql, [
            s.identity.sessionId,
            s.identity.sessionTokenHash,
            "cancel",
            c.recovery,
          ]),
          (e: unknown) => (e as { code: string }).code === "P0428",
        );
        await assert.rejects(
          runtime.query(sql, [
            s.identity.sessionId,
            s.identity.sessionTokenHash,
            "read",
            c.recovery,
          ]),
          (e: unknown) => (e as { code: string }).code === "22023",
        );
        await s.stepUp();
        await owner.query(
          "UPDATE admin_sessions SET revoked_at=clock_timestamp() WHERE id=$1",
          [s.identity.sessionId],
        );
        await assert.rejects(
          runtime.query(sql, [
            s.identity.sessionId,
            s.identity.sessionTokenHash,
            "cancel",
            c.recovery,
          ]),
          (e: unknown) => (e as { code: string }).code === "42501",
        );
      } finally {
        await runtime.end();
      }
    },
  );
  if (process.argv.includes("--browser")) {
    const { runRecoveryBrowser } = await import("./recovery-browser");
    const isolated = createApp(
      {
        postgres: async () => {},
        redis: async () => {},
        storage: async () => {},
      },
      pino({ level: "silent" }),
      origin,
      createLocalAdminRouter(origin, () => access),
    );
    await runRecoveryBrowser(isolated, owner, await recipient(), password);
  }
  console.log(
    `PASS ${checks} recovery SQL/API/mailbox scenarios; disposable database only`,
  );
} catch (error) {
  console.error("Recovery acceptance failed", {
    message: (error as Error).message,
    code: (error as { code?: string }).code,
  });
  process.exitCode = 1;
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
