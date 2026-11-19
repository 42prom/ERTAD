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
const database = `ertad_invites_${randomBytes(8).toString("hex")}`,
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
  await check(
    "scoped contacts, masked destinations, strict input and hidden technical authority",
    async () => {
      const ar = await invite(2, "contacts"),
        br = await invite(4, "contacts");
      assert.ok(ar.items.length);
      assert.ok(ar.items.every((c: { unitId: string }) => c.unitId === a));
      assert.ok(br.items.every((c: { unitId: string }) => c.unitId === b));
      assert.ok(!JSON.stringify(ar).includes("email"));
      await denied(invite(2, "contacts", { organizationId: randomUUID() }));
      await denied(invite(2, "list", { page: 0 }), 400);
      await denied(
        invitationCommand(sessions[2], "contexts", { extra: true }),
        400,
      );
      const regionB = await contact(b);
      await denied(cmd(2, "propose", payload(regionB)));
    },
  );
  await check(
    "proposal retry, independent approval and readable recipient without credential disclosure",
    async () => {
      const c = await contact(),
        input = payload(c),
        before = await count("admin_users"),
        p = await cmd(2, "propose", input);
      assert.deepEqual(await cmd(2, "propose", input), p);
      await denied(
        cmd(2, "propose", { ...input, reason: "Changed retry" }),
        409,
      );
      await denied(cmd(2, "vote", vote(p.id)));
      await denied(cmd(4, "vote", vote(p.id)));
      const detail = await cmd(3, "detail", { id: p.id });
      assert.equal(
        detail.invitationRecipient.displayName,
        "Synthetic invitation recipient",
      );
      assert.ok(!JSON.stringify(detail).includes(c.email));
      await cmd(3, "vote", vote(p.id));
      assert.equal(await count("admin_users"), before);
      assert.equal(
        (
          await owner.query(
            "SELECT token_hash FROM web_invitations WHERE id=$1",
            [p.id],
          )
        ).rows[0].token_hash,
        null,
      );
    },
  );
  await check(
    "actual HTTP activation requires Origin, strict body, valid token and password policy",
    async () => {
      const c = await delivered(),
        body = { id: c.invite, token: c.token, password };
      await request(app)
        .post(base + "/invitations/activate")
        .send(body)
        .expect(403);
      await request(app)
        .post(base + "/invitations/activate")
        .set("Origin", "https://untrusted.invalid")
        .send(body)
        .expect(403);
      await request(app)
        .post(base + "/invitations/activate")
        .set("Origin", origin)
        .send({ ...body, role: "super_admin" })
        .expect(400);
      await denied(activateInvitation({ ...body, password: "short" }), 400);
      await denied(
        activateInvitation({
          ...body,
          password: c.email.split("@")[0] + "-password",
        }),
        400,
      );
      await denied(
        activateInvitation({
          ...body,
          token: randomBytes(32).toString("base64url"),
        }),
        409,
      );
      const before = await count("memberships"),
        grants = await count("permission_grants");
      const result = await request(app)
        .post(base + "/invitations/activate")
        .set("Origin", origin)
        .send(body)
        .expect(200);
      assert.deepEqual(result.body, { activated: true });
      assert.equal(result.headers["set-cookie"], undefined);
      assert.equal(await count("memberships"), before);
      assert.equal(await count("permission_grants"), grants);
      const account = (
        await owner.query(
          "SELECT a.* FROM admin_users a JOIN member_users m ON m.web_account_id=a.id WHERE m.id=$1",
          [c.member],
        )
      ).rows[0];
      assert.equal(account.role, "observer");
      assert.equal(account.mfa_enabled, false);
      assert.equal(account.mfa_secret_encrypted, null);
      const login = await request
        .agent(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: c.email, password })
        .expect(200);
      assert.ok(login.body.csrfToken);
      await denied(activate(c), 409);
      await denied(invite(2, "revoke", { id: c.invite }));
      assert.equal(
        (await invite(2, "list")).items.find(
          (i: { id: string }) => i.id === c.invite,
        ).status,
        "activated",
      );
    },
  );
  await check(
    "concurrent activation admits one account and token consumption",
    async () => {
      const c = await delivered(),
        before = await count("admin_users");
      const results = await Promise.allSettled([activate(c), activate(c)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(await count("admin_users"), before + 1);
    },
  );
  await check(
    "revocation requires CSRF and current scoped authority and invalidates delivery",
    async () => {
      const c = await delivered();
      await sessions[2].agent
        .post(base + "/invitations/revoke")
        .set("Origin", origin)
        .send({ organizationId: org, id: c.invite })
        .expect(403);
      await denied(invite(4, "revoke", { id: c.invite }));
      await invite(2, "revoke", { id: c.invite });
      await invite(2, "revoke", { id: c.invite });
      await denied(activate(c), 409);
      assert.equal(
        (await invite(2, "list")).items.find(
          (i: { id: string }) => i.id === c.invite,
        ).status,
        "revoked",
      );
    },
  );
  await check(
    "expired link, revoked contact and suspended member cannot activate",
    async () => {
      for (const mutation of ["expiry", "contact", "member"]) {
        const c = await delivered();
        if (mutation === "expiry")
          await owner.query(
            "UPDATE web_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
            [c.invite],
          );
        if (mutation === "contact")
          await owner.query(
            "UPDATE web_invite_contacts SET revoked_at=now() WHERE id=$1",
            [c.id],
          );
        if (mutation === "member")
          await owner.query(
            "UPDATE member_users SET status='suspended' WHERE id=$1",
            [c.member],
          );
        await denied(activate(c), 409);
      }
    },
  );
  await check(
    "lost proposer/reviewer authority denies activation and changes displayed availability",
    async () => {
      for (const index of [2, 3]) {
        const c = await delivered();
        await owner.query(
          "UPDATE member_users SET status='suspended' WHERE id=$1",
          [access.accounts[index].memberId],
        );
        try {
          await denied(activate(c), 409);
          assert.equal(
            (await invite(0, "list")).items.find(
              (i: { id: string }) => i.id === c.invite,
            ).status,
            "unavailable",
          );
        } finally {
          await owner.query(
            "UPDATE member_users SET status='active' WHERE id=$1",
            [access.accounts[index].memberId],
          );
        }
      }
    },
  );
  await check(
    "audit outage and post-audit revocation roll activation back",
    async () => {
      await owner.query(
        `CREATE FUNCTION ertad.test_invite_tamper(target uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ UPDATE ertad.web_invitations SET revoked_at=clock_timestamp() WHERE id=target $$; GRANT EXECUTE ON FUNCTION ertad.test_invite_tamper(uuid) TO ertad_app`,
      );
      for (const tamper of [false, true]) {
        const c = await delivered(),
          before = await count("admin_users"),
          original = SecurityService.logAuditEventInTransaction;
        SecurityService.logAuditEventInTransaction = async (
          client,
          event,
          ...args
        ) => {
          if (event === "WEB_INVITATION_ACTIVATED") {
            if (!tamper) throw new Error("Synthetic audit outage");
            await client.query("SELECT ertad.test_invite_tamper($1)", [
              c.invite,
            ]);
          }
          return original.call(SecurityService, client, event, ...args);
        };
        try {
          if (tamper) await denied(activate(c), 409);
          else await assert.rejects(activate(c), /Synthetic audit outage/);
        } finally {
          SecurityService.logAuditEventInTransaction = original;
        }
        assert.equal(await count("admin_users"), before);
        assert.equal(
          (
            await owner.query(
              "SELECT consumed_at FROM web_invitations WHERE id=$1",
              [c.invite],
            )
          ).rows[0].consumed_at,
          null,
        );
        await activate(c);
      }
      await owner.query("DROP FUNCTION ertad.test_invite_tamper(uuid)");
    },
  );
  await check(
    "direct runtime storage/helpers denied; synthetic contact immutable and delivery cannot rotate",
    async () => {
      for (const sql of [
        "SELECT * FROM ertad.web_invite_contacts",
        "SELECT * FROM ertad.web_invitations",
        "SELECT ertad.web_invite_delivery(gen_random_uuid(),repeat('a',64))",
      ])
        await assert.rejects(
          db.query(sql),
          (e: unknown) => (e as { code: string }).code === "42501",
        );
      const c = await delivered();
      await assert.rejects(
        owner.query("UPDATE web_invite_contacts SET email=$1 WHERE id=$2", [
          "changed@example.invalid",
          c.id,
        ]),
      );
      await assert.rejects(
        owner.query("SELECT web_invite_delivery($1,$2)", [
          c.invite,
          digest(randomUUID()),
        ]),
      );
      const list = await invite(2, "list");
      assert.ok(!JSON.stringify(list).includes(c.token));
      assert.ok(!JSON.stringify(list).includes(c.email));
    },
  );
  await check(
    "technical role labels and unaffiliated accounts cannot issue or review invitations",
    async () => {
      const { hashAdminPassword } =
        await import("../backend/src/services/adminPassword");
      const email = `technical-${randomUUID()}@example.invalid`;
      const id = (
        await owner.query(
          "INSERT INTO admin_users(email,password_hash,role) VALUES($1,$2,'admin') RETURNING id",
          [email, await hashAdminPassword(password)],
        )
      ).rows[0].id;
      await owner.query(
        "INSERT INTO platform_accounts(admin_user_id,permissions,valid_until) VALUES($1,ARRAY['platform.read'],now()+interval '1 day')",
        [id],
      );
      const agent = request.agent(app);
      await agent
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email, password })
        .expect(200);
      await agent.get(base + "/invitations/contexts").expect(403);
      await agent
        .get(base + "/invitations/list")
        .query({ organizationId: org })
        .expect(403);
    },
  );
  await check(
    "expired step-up, pending contact revocation and self-invitation are denied without creating accounts",
    async () => {
      const c = await contact(),
        p = await cmd(2, "propose", payload(c));
      await owner.query(
        "UPDATE web_invite_contacts SET revoked_at=now() WHERE id=$1",
        [c.id],
      );
      await denied(cmd(3, "vote", vote(p.id)), 409);
      await cmd(3, "vote", { ...vote(p.id), choice: "reject" });
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM collective_proposals WHERE id=$1",
            [p.id],
          )
        ).rows[0].status,
        "pending",
      );
      await cmd(2, "withdraw", { id: p.id, version: 2, key: randomUUID() });
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM collective_proposals WHERE id=$1",
            [p.id],
          )
        ).rows[0].status,
        "withdrawn",
      );
      const own = randomUUID();
      await owner.query(
        "INSERT INTO web_invite_contacts(organization_id,id,unit_id,member_id,email,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 day')",
        [org, own, a, access.accounts[2].memberId, "self@example.invalid"],
      );
      await denied(cmd(2, "propose", payload({ id: own, unit: a })), 409);
      const active = await delivered();
      await owner.query(
        "UPDATE admin_sessions SET step_up_expires_at=now()-interval '1 second' WHERE id=$1",
        [sessions[2].sessionId],
      );
      await denied(invite(2, "revoke", { id: active.invite }), 428);
      await sessions[2].agent
        .post(base + "/demo/step-up")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send({})
        .expect(200);
    },
  );
  await check(
    "approval audit failure leaves the request pending with no activation record",
    async () => {
      const c = await contact(),
        p = await cmd(2, "propose", payload(c)),
        original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        ...args
      ) => {
        if (event === "COLLECTIVE_COMMAND")
          throw new Error("Synthetic review audit outage");
        return original.call(SecurityService, client, event, ...args);
      };
      try {
        await assert.rejects(
          cmd(3, "vote", vote(p.id)),
          /Synthetic review audit outage/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
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
        (await owner.query("SELECT 1 FROM web_invitations WHERE id=$1", [p.id]))
          .rowCount,
        0,
      );
    },
  );
  await check(
    "local mailbox delivers recipient-only tokens, never overwrites files and rolls back on audit failure",
    async () => {
      const { deliverSyntheticInvitation } =
        await import("./invitation-delivery");
      await mkdir(".local", { recursive: true });
      const directory = await mkdtemp(resolve(".local/invitation-test-"));
      try {
        const c = await approved();
        await deliverSyntheticInvitation(owner, c.invite, directory, origin);
        const contents = await readFile(
            resolve(directory, c.invite + ".json"),
            "utf8",
          ),
          message = JSON.parse(contents),
          url = new URL(message.url);
        assert.equal(message.to, c.email);
        assert.equal(url.origin, origin);
        assert.equal(url.pathname, "/activate");
        await activateInvitation({
          id: c.invite,
          token: url.hash.split(".")[1],
          password,
        });
        await assert.rejects(
          deliverSyntheticInvitation(owner, c.invite, directory, origin),
        );
        assert.equal(
          await readFile(resolve(directory, c.invite + ".json"), "utf8"),
          contents,
        );
        const failed = await approved(),
          original = SecurityService.logAuditEventInTransaction;
        SecurityService.logAuditEventInTransaction = async () => {
          throw new Error("Synthetic delivery audit outage");
        };
        try {
          await assert.rejects(
            deliverSyntheticInvitation(owner, failed.invite, directory, origin),
            /Synthetic delivery audit outage/,
          );
        } finally {
          SecurityService.logAuditEventInTransaction = original;
        }
        assert.equal(
          (
            await owner.query(
              "SELECT token_hash FROM web_invitations WHERE id=$1",
              [failed.invite],
            )
          ).rows[0].token_hash,
          null,
        );
        const pending = resolve(directory, failed.invite + ".json.pending");
        await writeFile(pending, "private-existing-pending-message", {
          flag: "wx",
        });
        await assert.rejects(
          deliverSyntheticInvitation(owner, failed.invite, directory, origin),
          (e: unknown) => (e as { code: string }).code === "EEXIST",
        );
        assert.equal(
          await readFile(pending, "utf8"),
          "private-existing-pending-message",
        );
        assert.equal(
          (
            await owner.query(
              "SELECT token_hash FROM web_invitations WHERE id=$1",
              [failed.invite],
            )
          ).rows[0].token_hash,
          null,
        );
        await assert.rejects(
          deliverSyntheticInvitation(
            owner,
            failed.invite,
            directory,
            "https://external.invalid",
          ),
          /Loopback/,
        );
      } finally {
        for (const file of await readdir(directory))
          await unlink(resolve(directory, file));
        await rmdir(directory);
      }
    },
  );
  if (process.argv.includes("--browser")) {
    const { runInvitationBrowser } = await import("./invitation-browser");
    await runInvitationBrowser(app, access, owner);
  }
  console.log(
    `PASS ${checks} invitation SQL/API scenarios; disposable database only`,
  );
} catch (error) {
  console.error("Invitation acceptance failed", {
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
