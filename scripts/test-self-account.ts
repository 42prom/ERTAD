import assert from "node:assert/strict";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";
import bcrypt from "bcrypt";
import type { Request, Response } from "express";
loadEnvFile(".env");
const database = "ertad_self_account_" + randomBytes(8).toString("hex");
const config = {
  host: "127.0.0.1",
  port: Number(process.env.ERTAD_POSTGRES_PORT ?? 15432),
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
process.env.API_KEY_ENCRYPTION_SECRET = randomBytes(32).toString("base64url");
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${config.port}/${database}`;
let created = false,
  connected = false,
  close: (() => Promise<void>) | undefined,
  checks = 0;
const origin = "http://localhost:15173",
  base = "/api/v1/admin/auth",
  security = base + "/security";
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
        MIGRATION_DATABASE_URL: `postgresql://ertad_owner:${encodeURIComponent(config.password!)}@127.0.0.1:${config.port}/${database}`,
      },
    },
  );
  await owner.connect();
  connected = true;
  const db = await import("../backend/src/db/client");
  close = db.close;
  const { createApp } = await import("../backend/src/app");
  const { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { SecurityService } = await import("../backend/src/services/security");
  const { selfAccountCommand } =
    await import("../backend/src/modules/identity/selfAccount");
  const originalAudit = SecurityService.logAuditEventInTransaction;
  async function fixture() {
    const app = createApp(
      {
        postgres: async () => {},
        redis: async () => {},
        storage: async () => {},
      },
      pino({ enabled: false }),
      origin,
      createLocalAdminRouter(origin),
    );
    const email = `synthetic-${randomUUID()}@example.invalid`,
      password = randomBytes(24).toString("base64url");
    const id = (
      await owner.query(
        "INSERT INTO admin_users(email,password_hash,role) VALUES($1,$2,'observer') RETURNING id",
        [
          email,
          await bcrypt.hash(password, 10),
        ],
      )
    ).rows[0].id;
    async function login(secret = password) {
      const agent = request.agent(app);
      const r = await agent
        .post(base + "/login")
        .set("Origin", origin)
        .send({ email, password: secret })
        .expect(200);
      const cookie = (r.headers["set-cookie"] as unknown as string[])[0].split(
        ";",
      )[0];
      const hash = createHash("sha256")
        .update(cookie.split("=")[1])
        .digest("hex");
      const s = (
        await owner.query("SELECT id FROM admin_sessions WHERE token_hash=$1", [
          hash,
        ])
      ).rows[0];
      return {
        agent,
        csrf: r.body.csrfToken as string,
        sessionId: s.id as string,
        sessionTokenHash: hash,
      };
    }
    const first = await login(),
      second = await login();
    const post = (s: typeof first, path: string, body: unknown) =>
      s.agent
        .post(path)
        .set("Origin", origin)
        .set("X-Admin-Csrf", s.csrf)
        .send(body);
    const step = (s = first) =>
      post(s, base + "/step-up", { password }).expect(200);
    return { app, id, email, password, first, second, post, step, login };
  }
  async function check(name: string, fn: () => Promise<void>) {
    if (process.argv.includes("--browser-only")) return;
    try {
      await fn();
      checks++;
      console.log("PASS " + name);
    } finally {
      SecurityService.logAuditEventInTransaction = originalAudit;
    }
  }
  await check(
    "personal session list is scoped, bounded and credential-free without organizational grants",
    async () => {
      const f = await fixture(),
        other = await fixture();
      const r = await f.first.agent
        .get(security + "/sessions")
        .expect("Cache-Control", "no-store")
        .expect(200);
      assert.equal(r.body.items.length, 2);
      assert.equal(r.body.items.filter((s: any) => s.current).length, 1);
      assert.ok(!JSON.stringify(r.body).includes(other.first.sessionId));
      assert.deepEqual(Object.keys(r.body.items[0]).sort(), [
        "clientLabel",
        "createdAt",
        "current",
        "expiresAt",
        "id",
        "lastSeenAt",
      ]);
      await request(f.app)
        .get(security + "/sessions")
        .expect(401);
      await f.first.agent
        .get(security + "/sessions?accountId=" + other.id)
        .expect(400);
    },
  );
  await check(
    "CSRF, Origin, fresh step-up, strict bodies and current-session logout boundary",
    async () => {
      const f = await fixture();
      await f.first.agent
        .post(security + "/sessions/revoke")
        .set("Origin", origin)
        .send({ sessionId: f.second.sessionId })
        .expect(403);
      await f.first.agent
        .post(security + "/sessions/revoke")
        .set("Origin", "https://invalid.example")
        .set("X-Admin-Csrf", f.first.csrf)
        .send({ sessionId: f.second.sessionId })
        .expect(403);
      await f
        .post(f.first, security + "/sessions/revoke", {
          sessionId: f.second.sessionId,
        })
        .expect(428);
      await f
        .post(f.first, security + "/password", {
          newPassword: randomBytes(24).toString("base64url"),
        })
        .expect(428);
      await f.step();
      await f
        .post(f.first, security + "/sessions/revoke", {
          sessionId: f.first.sessionId,
        })
        .expect(400);
      await f
        .post(f.first, security + "/password", {
          newPassword: randomBytes(24).toString("base64url"),
          accountId: f.id,
        })
        .expect(400);
    },
  );
  await check(
    "foreign session IDs cannot be read or revoked, even after step-up",
    async () => {
      const f = await fixture(),
        other = await fixture();
      await f.step();
      await f
        .post(f.first, security + "/sessions/revoke", {
          sessionId: other.first.sessionId,
        })
        .expect(404);
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM admin_sessions WHERE id=$1",
            [other.first.sessionId],
          )
        ).rows[0].revoked_at,
        null,
      );
    },
  );
  await check(
    "concurrent revocation retries affect one own session and retain current access",
    async () => {
      const f = await fixture();
      await f.step();
      const results = await Promise.all(
        [1, 2].map(() =>
          selfAccountCommand(f.first, "revoke", {
            sessionId: f.second.sessionId,
          }),
        ),
      );
      assert.deepEqual(results[0], results[1]);
      await f.second.agent.get(base + "/me").expect(401);
      await f.first.agent.get(base + "/me").expect(200);
    },
  );
  await check(
    "password policy rejects short, oversized UTF-8, unchanged and email-derived secrets",
    async () => {
      const f = await fixture();
      await f.step();
      for (const password of [
        "short",
        "ა".repeat(25),
        f.password,
        f.email.split("@")[0] + "random",
      ])
        await f
          .post(f.first, security + "/password", { newPassword: password })
          .expect(400);
      await f.first.agent.get(base + "/me").expect(200);
    },
  );
  await check(
    "password rotation changes only credentials, revokes all sessions and requires a new login",
    async () => {
      const f = await fixture();
      await f.step();
      const before = (
        await owner.query(
          "SELECT role,is_active,mfa_secret_encrypted FROM admin_users WHERE id=$1",
          [f.id],
        )
      ).rows[0];
      const next = randomBytes(24).toString("base64url");
      const result = await f
        .post(f.first, security + "/password", { newPassword: next })
        .expect(200);
      assert.deepEqual(result.body, { signedOut: true });
      assert.deepEqual(
        (
          await owner.query(
            "SELECT role,is_active,mfa_secret_encrypted FROM admin_users WHERE id=$1",
            [f.id],
          )
        ).rows[0],
        before,
      );
      await f.first.agent.get(base + "/me").expect(401);
      await f.second.agent.get(base + "/me").expect(401);
      await request(f.app)
        .post(base + "/login")
        .set("Origin", origin)
        .send({ email: f.email, password: f.password })
        .expect(401);
      await f.login(next);
      const audit = (
        await owner.query(
          "SELECT payload FROM audit_log WHERE event_type='ADMIN_OWN_PASSWORD_CHANGED'",
        )
      ).rows;
      assert.ok(audit.length);
      assert.ok(!JSON.stringify(audit).includes(next));
      assert.ok(!JSON.stringify(audit).includes(f.email));
    },
  );
  await check(
    "concurrent password changes admit one winner and no surviving old sessions",
    async () => {
      const f = await fixture();
      await f.step();
      await f.step(f.second);
      const results = await Promise.allSettled([
        selfAccountCommand(f.first, "password", {
          newPassword: randomBytes(24).toString("base64url"),
        }),
        selfAccountCommand(f.second, "password", {
          newPassword: randomBytes(24).toString("base64url"),
        }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
            [f.id],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await check(
    "audit outage rolls back password and all session revocations",
    async () => {
      const f = await fixture();
      await f.step();
      const before = (
        await owner.query("SELECT password_hash FROM admin_users WHERE id=$1", [
          f.id,
        ])
      ).rows[0];
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("synthetic audit outage");
      };
      await assert.rejects(
        selfAccountCommand(f.first, "password", {
          newPassword: randomBytes(24).toString("base64url"),
        }),
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT password_hash FROM admin_users WHERE id=$1",
            [f.id],
          )
        ).rows[0],
        before,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
            [f.id],
          )
        ).rows[0].n,
        2,
      );
    },
  );
  await check(
    "audit-time account locking rolls back credential rotation",
    async () => {
      const f = await fixture();
      await f.step();
      SecurityService.logAuditEventInTransaction = async (
        c,
        event,
        payload,
      ) => {
        await originalAudit(c, event, payload);
        await c.query(
          "UPDATE admin_users SET locked_until=now()+interval '1 hour' WHERE id=$1",
          [f.id],
        );
      };
      await assert.rejects(
        selfAccountCommand(f.first, "password", {
          newPassword: randomBytes(24).toString("base64url"),
        }),
        (e: any) => e.statusCode === 409,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT locked_until FROM admin_users WHERE id=$1",
            [f.id],
          )
        ).rows[0].locked_until,
        null,
      );
    },
  );
  await check(
    "audit-time step-up expiry rolls back session revocation",
    async () => {
      const f = await fixture();
      await f.step();
      SecurityService.logAuditEventInTransaction = async (
        c,
        event,
        payload,
      ) => {
        await originalAudit(c, event, payload);
        await c.query(
          "UPDATE admin_sessions SET step_up_expires_at=now()-interval '1 second' WHERE id=$1",
          [f.first.sessionId],
        );
      };
      await assert.rejects(
        selfAccountCommand(f.first, "revoke", {
          sessionId: f.second.sessionId,
        }),
        (e: any) => e.statusCode === 428,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM admin_sessions WHERE id=$1",
            [f.second.sessionId],
          )
        ).rows[0].revoked_at,
        null,
      );
    },
  );
  await check(
    "bulk revocation enforces authentication, CSRF, Origin, fresh step-up and strict target-free input",
    async () => {
      const f = await fixture();
      const path = security + "/sessions/revoke-others";
      await request(f.app)
        .post(path)
        .set("Origin", origin)
        .send({})
        .expect(401);
      await f.first.agent.post(path).set("Origin", origin).send({}).expect(403);
      await f.first.agent
        .post(path)
        .set("Origin", "https://invalid.example")
        .set("X-Admin-Csrf", f.first.csrf)
        .send({})
        .expect(403);
      await f.post(f.first, path, {}).expect(428);
      await f.step();
      await f.post(f.first, path, { accountId: f.id }).expect(400);
      await f
        .post(f.first, path, { sessionId: f.second.sessionId })
        .expect(400);
    },
  );
  await check(
    "bulk revocation covers all pages and expired sessions, preserves caller, credentials and other accounts",
    async () => {
      const f = await fixture(),
        other = await fixture();
      const history = await f.login();
      await f.step();
      await owner.query(
        "UPDATE admin_sessions SET revoked_at=now()-interval '1 hour',step_up_expires_at=NULL WHERE id=$1",
        [history.sessionId],
      );
      // Synthetic rows exercise the pagination boundary without increasing the login cap.
      for (let i = 0; i < 28; i++)
        await owner.query(
          `INSERT INTO admin_sessions(admin_user_id,token_hash,csrf_token_hash,
        csrf_token_encrypted,idle_expires_at,absolute_expires_at,step_up_expires_at)
        SELECT admin_user_id,$2,csrf_token_hash,csrf_token_encrypted,
        CASE WHEN $3 THEN now()-interval '1 minute' ELSE idle_expires_at END,
        absolute_expires_at,step_up_expires_at FROM admin_sessions WHERE id=$1`,
          [f.first.sessionId, randomBytes(32).toString("hex"), i === 0],
        );
      const before = (
        await owner.query(
          "SELECT to_jsonb(a) data FROM admin_users a WHERE id=$1",
          [f.id],
        )
      ).rows[0].data;
      const oldTimestamp = (
        await owner.query("SELECT revoked_at FROM admin_sessions WHERE id=$1", [
          history.sessionId,
        ])
      ).rows[0].revoked_at;
      const r = await f
        .post(f.first, security + "/sessions/revoke-others", {})
        .expect(200);
      assert.deepEqual(r.body, { revokedCount: 29 });
      assert.deepEqual(
        (
          await owner.query(
            "SELECT to_jsonb(a) data FROM admin_users a WHERE id=$1",
            [f.id],
          )
        ).rows[0].data,
        before,
      );
      const live = (
        await owner.query(
          "SELECT id FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
          [f.id],
        )
      ).rows;
      assert.deepEqual(live, [{ id: f.first.sessionId }]);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND id<>$2 AND step_up_expires_at IS NOT NULL",
            [f.id, f.first.sessionId],
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT revoked_at FROM admin_sessions WHERE id=$1",
            [history.sessionId],
          )
        ).rows[0].revoked_at,
        oldTimestamp,
      );
      await f.second.agent.get(base + "/me").expect(401);
      await other.first.agent.get(base + "/me").expect(200);
      await f.first.agent.get(base + "/me").expect(200);
      const again = await f
        .post(f.first, security + "/sessions/revoke-others", {})
        .expect(200);
      assert.equal(again.body.revokedCount, 0);
      const later = await f.login();
      await later.agent.get(base + "/me").expect(200);
    },
  );
  await check(
    "competing all-other revocations cannot leave the winning caller revoked",
    async () => {
      const f = await fixture();
      await f.step();
      await f.step(f.second);
      const results = await Promise.allSettled([
        selfAccountCommand(f.first, "revokeOthers", {}),
        selfAccountCommand(f.second, "revokeOthers", {}),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const winner = results[0].status === "fulfilled" ? f.first : f.second;
      assert.deepEqual(
        (
          await owner.query(
            "SELECT id FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
            [f.id],
          )
        ).rows,
        [{ id: winner.sessionId }],
      );
    },
  );
  await check(
    "bulk revocation and its audit roll back together on audit outage",
    async () => {
      const f = await fixture();
      await f.step();
      SecurityService.logAuditEventInTransaction = async (
        c,
        event,
        payload,
      ) => {
        await originalAudit(c, event, payload);
        throw new Error("synthetic audit outage");
      };
      await assert.rejects(selfAccountCommand(f.first, "revokeOthers", {}));
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
            [f.id],
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM audit_log WHERE event_type='ADMIN_OWN_OTHER_SESSIONS_REVOKED' AND payload::jsonb->>'adminUserId'=$1",
            [f.id],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await check(
    "bulk revocation rejects audit-time expiry and restored target sessions",
    async () => {
      for (const tamper of ["expiry", "target"] as const) {
        const f = await fixture();
        await f.step();
        SecurityService.logAuditEventInTransaction = async (
          c,
          event,
          payload,
        ) => {
          await originalAudit(c, event, payload);
          if (tamper === "expiry")
            await c.query(
              "UPDATE admin_sessions SET step_up_expires_at=now()-interval '1 second' WHERE id=$1",
              [f.first.sessionId],
            );
          else
            await c.query(
              "UPDATE admin_sessions SET revoked_at=NULL WHERE id=$1",
              [f.second.sessionId],
            );
        };
        await assert.rejects(
          selfAccountCommand(f.first, "revokeOthers", {}),
          (e: any) => e.statusCode === (tamper === "expiry" ? 428 : 409),
        );
        SecurityService.logAuditEventInTransaction = originalAudit;
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
              [f.id],
            )
          ).rows[0].n,
          2,
        );
      }
    },
  );
  await check(
    "runtime cannot directly write passwords; SQL rotation rejects wrong token and hash",
    async () => {
      const f = await fixture();
      await f.step();
      await assert.rejects(
        db.pool.query("UPDATE admin_users SET password_hash=$1 WHERE id=$2", [
          "invalid",
          f.id,
        ]),
        (e: any) => e.code === "42501",
      );
      const old = (
        await owner.query("SELECT password_hash FROM admin_users WHERE id=$1", [
          f.id,
        ])
      ).rows[0].password_hash;
      await assert.rejects(
        db.pool.query("SELECT ertad.replace_own_admin_password($1,$2,$3,$4)", [
          f.first.sessionId,
          "0".repeat(64),
          old,
          old,
        ]),
        (e: any) => e.code === "42501",
      );
      await assert.rejects(
        db.pool.query("SELECT ertad.replace_own_admin_password($1,$2,$3,$4)", [
          f.first.sessionId,
          f.first.sessionTokenHash,
          old,
          "invalid",
        ]),
        (e: any) => e.code === "22023",
      );
    },
  );
  await check(
    "stale password verification cannot create a session after rotation",
    async () => {
      const f = await fixture();
      await f.step();
      const old = (
        await owner.query("SELECT password_hash FROM admin_users WHERE id=$1", [
          f.id,
        ])
      ).rows[0].password_hash;
      await selfAccountCommand(f.first, "password", {
        newPassword: randomBytes(24).toString("base64url"),
      });
      const { createAdminSession } =
        await import("../backend/src/services/adminSession");
      let cookieIssued = false;
      await assert.rejects(
        createAdminSession(
          f.id,
          {} as Request,
          {
            append() {
              cookieIssued = true;
            },
          } as unknown as Response,
          old,
          f.email,
        ),
        (e: any) => e.statusCode === 401,
      );
      assert.equal(cookieIssued, false);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
            [f.id],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await check(
    "session revoked during login audit cannot receive a cookie",
    async () => {
      const f = await fixture();
      SecurityService.logAuditEventInTransaction = async (
        c,
        event,
        payload,
      ) => {
        await originalAudit(c, event, payload);
        if (event === "ADMIN_LOGIN_SUCCEEDED")
          await c.query(
            "UPDATE admin_sessions SET revoked_at=now() WHERE admin_user_id=$1",
            [f.id],
          );
      };
      const response = await request(f.app)
        .post(base + "/login")
        .set("Origin", origin)
        .send({ email: f.email, password: f.password })
        .expect(401);
      assert.equal(response.headers["set-cookie"], undefined);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
            [f.id],
          )
        ).rows[0].n,
        2,
      );
    },
  );
  await check('email changed during login audit cannot receive a cookie or commit the login',async()=>{
    const f=await fixture();
    await owner.query("CREATE FUNCTION ertad.test_login_email_change(account uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ UPDATE ertad.admin_users SET email='changed-during-audit@example.invalid' WHERE id=account $$; GRANT EXECUTE ON FUNCTION ertad.test_login_email_change(uuid) TO ertad_app");
    SecurityService.logAuditEventInTransaction=async(c,event,payload)=>{await originalAudit(c,event,payload);if(event==='ADMIN_LOGIN_SUCCEEDED')await c.query('SELECT ertad.test_login_email_change($1)',[f.id]);};
    try{
      const response=await request(f.app).post(base+'/login').set('Origin',origin).send({email:f.email,password:f.password}).expect(401);
      assert.equal(response.headers['set-cookie'],undefined);
      assert.equal((await owner.query('SELECT email FROM admin_users WHERE id=$1',[f.id])).rows[0].email,f.email);
      assert.equal((await owner.query('SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL',[f.id])).rows[0].n,2);
    }finally{SecurityService.logAuditEventInTransaction=originalAudit;await owner.query('DROP FUNCTION ertad.test_login_email_change(uuid)');}
  });
  if (process.argv.includes("--browser")) {
    const f = await fixture();
    const { selfAccountBrowser } = await import("./self-account-browser");
    const next = await selfAccountBrowser(f.app, f.email, f.password);
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
          [f.id],
        )
      ).rows[0].n,
      0,
    );
    assert.ok(
      await bcrypt.compare(
        next,
        (
          await owner.query(
            "SELECT password_hash FROM admin_users WHERE id=$1",
            [f.id],
          )
        ).rows[0].password_hash,
      ),
    );
    await f.login(next);
    console.log(
      "PASS browser changes persisted; new password authenticates and prior sessions remain revoked",
    );
  }
  console.log(
    process.argv.includes("--browser-only")
      ? "PASS isolated personal account browser fixture"
      : `PASS ${checks} self-account SQL/API scenarios; disposable database only`,
  );
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
