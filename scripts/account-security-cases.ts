import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { accountSecurityCommand as command } from "../backend/src/modules/security/accountSecurity";
import { enablePlatformAccountSecurity,enablePlatformSessionResponse } from "./platform-fixture";
import {platformCommand} from '../backend/src/modules/security/platform';
import { deliverSecurityMailBatch } from "../backend/src/modules/identity/mailDelivery";
import {
  activateInvitation,
  confirmContact,
} from "../backend/src/modules/identity/invitations";
import {
  requestRecovery,
  completeRecovery,
} from "../backend/src/modules/identity/recovery";
import { ownEmailCommand } from "../backend/src/modules/identity/emailChange";
import { SecurityService } from "../backend/src/services/security";
import { createAdminSession } from "../backend/src/services/adminSession";
export async function verifyAccountSecurity({
  ctx,
  tech,
  reviewer,
  realApproved,
  send,
  sent,
  job,
}: any) {
  const { owner, db, app, sessions, check, denied, access } = ctx,
    origin = "http://localhost:15173",
    base = "/api/v1/admin",
    password = "Synthetic-account-security-573!";
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  async function login(email: string, secret: string) {
    const agent = request.agent(app),
      r = await agent
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email, password: secret })
        .expect(200);
    const identity = (
      await owner.query(
        'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1 AND csrf_token_hash=$2',
        [r.body.user.id, hash(r.body.csrfToken)],
      )
    ).rows[0];
    return {
      ...identity,
      agent,
      csrf: r.body.csrfToken,
      accountId: r.body.user.id,
    };
  }
  async function step(session: any, secret: string) {
    await session.agent
      .post(base + "/auth/step-up")
      .set("Origin", origin)
      .set("X-Admin-CSRF", session.csrf)
      .send({ password: secret })
      .expect(200);
  }
  async function fixture() {
    const c = await realApproved();
    await deliverSecurityMailBatch(send);
    const p = sent.find(
      (m: any) => m.id === c.invite && m.purpose === "contact",
    );
    await confirmContact({ id: p.id, token: p.token });
    await deliverSecurityMailBatch(send);
    const i = sent.find(
      (m: any) => m.id === c.invite && m.purpose === "invitation",
    );
    await activateInvitation({ id: i.id, token: i.token, password });
    const session = await login(c.email, password);
    await step(session, password);
    return { ...c, session, accountId: session.accountId };
  }
  const operator = await login(tech.email, tech.password),
    second = await login(reviewer.email, reviewer.password);
  await step(operator, tech.password);
  await step(second, reviewer.password);
  await check(
    "permissions require explicit installation preserving credential/grant lifetime",
    async () => {
      await denied(command(operator, "list", {}), 403);
      const before = (
        await owner.query(
          "SELECT a.password_hash,p.valid_until,p.revoked_at FROM admin_users a JOIN platform_accounts p ON p.admin_user_id=a.id WHERE a.id=$1",
          [tech.id],
        )
      ).rows[0];
      await owner.query("BEGIN");
      await enablePlatformAccountSecurity(owner, tech.id);
      await enablePlatformAccountSecurity(owner, reviewer.id, "reviewer");
      await owner.query("COMMIT");
      assert.equal(await enablePlatformAccountSecurity(owner, tech.id), false);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT a.password_hash,p.valid_until,p.revoked_at FROM admin_users a JOIN platform_accounts p ON p.admin_user_id=a.id WHERE a.id=$1",
            [tech.id],
          )
        ).rows[0],
        before,
      );
      await denied(command(sessions[0], "list", {}), 403);
    },
  );
  await enablePlatformSessionResponse(owner,tech.id);
  const f = await fixture();
  if (process.argv.includes("--browser-only")) {
    await (
      await import("./account-security-browser")
    ).verifyAccountSecurityBrowser({
      ctx,
      recipient: f,
      tech,
      reviewer,
      send,
      sent,
      password,
    });
    return;
  }
  const hold = (f: any, actor = operator, key = randomUUID()) =>
    command(actor, "hold", {
      accountId: f.accountId,
      requestId: key,
      reason: "suspected_compromise",
    });
  const release = (h: any, actor = second, key = randomUUID()) =>
    command(actor, "release", { holdId: h.id, requestId: key });
  async function recover(f: any, next = "Synthetic-account-recovered-594!") {
    await requestRecovery({ email: f.email });
    await deliverSecurityMailBatch(send);
    const message = [...sent]
      .reverse()
      .find((m: any) => m.purpose === "recovery" && m.email === f.email);
    assert(message);
    await completeRecovery({
      id: message.id,
      token: message.token,
      password: next,
    });
    return next;
  }
  const snapshot = async (id: string) =>
    (
      await owner.query(
        "SELECT a.email,a.is_active,a.password_hash,a.role,a.mfa_enabled,a.mfa_secret_encrypted,(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM memberships m JOIN member_users u ON u.id=m.user_id WHERE u.web_account_id=a.id) memberships FROM admin_users a WHERE a.id=$1",
        [id],
      )
    ).rows[0];
  await check(
    "Origin/CSRF/fresh password and strict inputs; bootstrap/MFA/technical protection",
    async () => {
      const body = {
        accountId: f.accountId,
        requestId: randomUUID(),
        reason: "suspected_compromise",
      };
      await operator.agent
        .post(base + "/platform/accounts/hold")
        .set("Origin", origin)
        .send(body)
        .expect(403);
      await operator.agent
        .post(base + "/platform/accounts/hold")
        .set("Origin", "https://foreign.example.test")
        .set("X-Admin-CSRF", operator.csrf)
        .send(body)
        .expect(403);
      const fresh = await login(tech.email, tech.password);
      await fresh.agent
        .post(base + "/platform/accounts/hold")
        .set("Origin", origin)
        .set("X-Admin-CSRF", fresh.csrf)
        .send(body)
        .expect(428);
      await operator.agent
        .post(base + "/platform/accounts/hold")
        .set("Origin", origin)
        .set("X-Admin-CSRF", operator.csrf)
        .send({ ...body, email: "forged@example.test" })
        .expect(400);
      await denied(hold({ accountId: tech.id }), 409);
      await denied(hold({ accountId: access.accounts[0].id }), 409);
      const rows = await command(operator, "list", {});
      assert(
        rows.items.every(
          (a: any) => !a.email && !a.password_hash && !a.memberId,
        ),
      );
      assert(!rows.items.some((a: any) => a.id === tech.id));
      assert.equal(
        rows.items.find((a: any) => a.id === f.accountId).recoverable,
        true,
      );
      assert.equal(
        (await command(operator, "list", { accountId: f.accountId })).items
          .length,
        1,
      );
    },
  );
  const sessionRows=await platformCommand(operator,'sessions',{});
  assert(sessionRows.items.some((s:any)=>s.accountId===f.accountId));
  const savedPermissions=(await owner.query('SELECT permissions FROM platform_accounts WHERE admin_user_id=$1',[tech.id])).rows[0].permissions;
  await owner.query("UPDATE platform_accounts SET permissions=array_remove(permissions,'platform.accounts.read') WHERE admin_user_id=$1",[tech.id]);
  try{assert((await platformCommand(operator,'sessions',{})).items.every((s:any)=>!('accountId' in s)));}
  finally{await owner.query('UPDATE platform_accounts SET permissions=$2 WHERE admin_user_id=$1',[tech.id,savedPermissions]);}
  let h: any, oldRecovery: any, oldChange: any, oldProof: any;
  await check(
    "hold blocks sessions/login/old proofs without changing cross-region memberships",
    async () => {
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) SELECT organization_id,$1,unit_id,position_id,bundle_version,valid_from,valid_until FROM memberships WHERE user_id=$2 LIMIT 1",
        [f.member, access.accounts[4].memberId],
      );
      const before = await snapshot(f.accountId);
      await login(f.email, password);
      oldChange = await ownEmailCommand(f.session, "request", {
        requestId: randomUUID(),
        newEmail: "pending-security-" + randomUUID() + "@example.test",
      });
      await requestRecovery({ email: f.email });
      await deliverSecurityMailBatch(send);
      oldRecovery = sent.find(
        (m: any) => m.purpose === "recovery" && m.email === f.email,
      );
      oldProof = sent.find(
        (m: any) => m.id === oldChange.id && m.purpose === "email_change",
      );
      assert(oldRecovery && oldProof);
      h = await hold(f);
      assert.deepEqual(await snapshot(f.accountId), before);
      await f.session.agent.get(base + "/auth/me").expect(401);
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: f.email, password })
        .expect(401);
      await denied(
        completeRecovery({
          id: oldRecovery.id,
          token: oldRecovery.token,
          password: "Synthetic-old-proof-595!",
        }),
        409,
      );
      await denied(
        ownEmailCommand(f.session, "confirm", {
          id: oldChange.id,
          newEmail: oldProof.email,
          token: oldProof.token,
        }),
        403,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL",
            [f.accountId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await job(oldChange.id, "email_change")).token_cipher,
        null,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM admin_sessions WHERE id=$1",
            [sessions[4].sessionId],
          )
        ).rows[0].revoked_at,
        null,
      );
      await denied(release(h), 409);
    },
  );
  await check(
    "recipient recovery while held and independent release preserve credentials/authority; old sessions stay closed",
    async () => {
      const next = await recover(f);
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: f.email, password: next })
        .expect(401);
      await owner.query(
        "UPDATE platform_accounts SET permissions=permissions||ARRAY['platform.accounts.release'] WHERE admin_user_id=$1",
        [tech.id],
      );
      await denied(release(h, operator), 409);
      const before = await snapshot(f.accountId),
        key = randomUUID(),
        receipt = await release(h, second, key);
      assert(receipt.releasedAt);
      assert.deepEqual(await release(h, second, key), receipt);
      assert.deepEqual(await snapshot(f.accountId), before);
      const resumed = await login(f.email, next);
      await resumed.agent.get(base + "/auth/me").expect(200);
      await f.session.agent.get(base + "/auth/me").expect(401);
      assert.equal(
        (await command(operator, "list", { accountId: f.accountId })).items[0]
          .hold,
        null,
      );
    },
  );
  await check(
    "old receipts cannot affect replacements; competing holds have one winner",
    async () => {
      const c = await fixture();
      await owner.query(
        "UPDATE platform_accounts SET permissions=permissions||ARRAY['platform.accounts.hold'] WHERE admin_user_id=$1",
        [reviewer.id],
      );
      const key = randomUUID(),
        first = await hold(c, operator, key);
      assert.equal((await hold(c, operator, key)).id, first.id);
      await denied(
        command(operator, "hold", {
          accountId: f.accountId,
          requestId: key,
          reason: "suspected_compromise",
        }),
        409,
      );
      await recover(c);
      const releaseKey = randomUUID();
      await release(first, second, releaseKey);
      const outcomes = await Promise.allSettled([hold(c), hold(c, second)]);
      assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
      await hold(c, operator, key);
      await release(first, second, releaseKey);
      const current = (
        await command(operator, "list", { accountId: c.accountId })
      ).items[0].hold;
      assert(current && current.id !== first.id);
    },
  );
  await check(
    "audit outage and revoked operator authority roll back security mutations",
    async () => {
      const c = await fixture(),
        before = await snapshot(c.accountId),
        original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        if (event === "PLATFORM_ACCOUNT_HELD")
          throw Error("synthetic audit outage");
        return original(client, event, data);
      };
      try {
        await assert.rejects(hold(c));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (await command(operator, "list", { accountId: c.accountId })).items[0]
          .hold,
        null,
      );
      await c.session.agent.get(base + "/auth/me").expect(200);
      await owner.query(
        "CREATE FUNCTION ertad.test_hold_revoke(actor uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ UPDATE ertad.platform_accounts SET revoked_at=clock_timestamp() WHERE admin_user_id=actor $$; GRANT EXECUTE ON FUNCTION ertad.test_hold_revoke(uuid) TO ertad_app",
      );
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        await original(client, event, data);
        if (event === "PLATFORM_ACCOUNT_HELD")
          await client.query("SELECT ertad.test_hold_revoke($1)", [tech.id]);
      };
      try {
        await denied(hold(c), 403);
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query("DROP FUNCTION ertad.test_hold_revoke(uuid)");
      }
      assert.deepEqual(await snapshot(c.accountId), before);
      assert.equal(
        (await command(operator, "list", { accountId: c.accountId })).items[0]
          .hold,
        null,
      );
      const held = await hold(c);
      await recover(c);
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        if (event === "PLATFORM_ACCOUNT_RELEASED")
          throw Error("synthetic release audit outage");
        return original(client, event, data);
      };
      try {
        await assert.rejects(release(held));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (await command(operator, "list", { accountId: c.accountId })).items[0]
          .hold.id,
        held.id,
      );
      await release(held);
    },
  );
  await check(
    "runtime SQL and stale login cannot resurrect held sessions, including old repeatable-read snapshots",
    async () => {
      const c = await fixture(),
        stale = new pg.Client({ connectionString: process.env.DATABASE_URL,options:'-c search_path=ertad,public' });
      await stale.connect();
      try {
        await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await stale.query("SELECT id FROM admin_users WHERE id=$1", [
          c.accountId,
        ]);
        await hold(c);
        await assert.rejects(
          stale.query("UPDATE admin_sessions SET revoked_at=NULL WHERE id=$1", [
            c.session.sessionId,
          ]),
          (e: any) => ["40001", "42501"].includes(e.code),
        );
        await stale.query("ROLLBACK");
      } finally {
        await stale.end();
      }
      await assert.rejects(
        db.query("UPDATE admin_sessions SET revoked_at=NULL WHERE id=$1", [
          c.session.sessionId,
        ]),
        (e: any) => e.code === "42501",
      );
      const account = (
        await owner.query(
          "SELECT email,password_hash FROM admin_users WHERE id=$1",
          [c.accountId],
        )
      ).rows[0];
      let cookie = false;
      await assert.rejects(
        createAdminSession(
          c.accountId,
          {} as any,
          {
            append() {
              cookie = true;
            },
          } as any,
          account.password_hash,
          account.email,
        ),
        (e: any) => e.statusCode === 401,
      );
      assert.equal(cookie, false);
      const racing=await fixture();
      const [held,entry]=await Promise.all([hold(racing),request(app).post(base+'/auth/login').set('Origin',origin).send({email:racing.email,password})]);
      assert(held.id);assert([200,401].includes(entry.status));
      assert.equal((await owner.query('SELECT count(*)::int n FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL',[racing.accountId])).rows[0].n,0);
      await assert.rejects(
        db.query("SELECT * FROM web_account_security_holds"),
        (e: any) => e.code === "42501",
      );
      await assert.rejects(
        db.query(
          "UPDATE web_account_security_holds SET released_at=clock_timestamp()",
        ),
        (e: any) => e.code === "42501",
      );
    },
  );
  await check(
    "bounded private pagination/filtering and minimal required audit",
    async () => {
      for (let i = 0; i < 27; i++) {
        const id = randomUUID();
        await owner.query(
          "INSERT INTO admin_users(id,email,password_hash,role) SELECT $1,$2,password_hash,'observer' FROM admin_users WHERE id=$3",
          [id, "page-" + i + "@example.test", tech.id],
        );
        await owner.query(
          "INSERT INTO member_users(web_account_id) VALUES($1)",
          [id],
        );
      }
      const page = await command(operator, "list", {});
      assert.equal(page.items.length, 25);
      assert(page.nextBefore);
      const next = await command(operator, "list", { before: page.nextBefore });
      assert(
        !next.items.some((a: any) =>
          page.items.some((b: any) => b.id === a.id),
        ),
      );
      assert(
        (await command(operator, "list", { state: "held" })).items.every(
          (a: any) => a.hold,
        ),
      );
      const audits = (
        await owner.query(
          "SELECT payload::text body FROM audit_log WHERE event_type IN ('PLATFORM_ACCOUNT_HELD','PLATFORM_ACCOUNT_RELEASED')",
        )
      ).rows;
      assert(audits.length);
      for (const { body } of audits) {
        assert(!body.includes("@"));
        assert(!body.includes("fingerprint"));
        assert(!body.includes(password));
      }
    },
  );
  await check(
    "governed account-wide disable/restore, lost-contact recovery and MFA reset enforce independent review and isolation",
    async () => {
      const target = await fixture();
      const orgBefore = await snapshot(target.accountId);
      const propDisable = await command(operator, "propose", {
        accountId: target.accountId,
        requestId: randomUUID(),
        action: "disable_account",
        reason: "policy_violation",
      });
      assert.equal(propDisable.status, "pending");
      await denied(
        command(operator, "review", {
          proposalId: propDisable.id,
          requestId: randomUUID(),
          decision: "approve",
        }),
        403,
      );
      const revDisable = await command(second, "review", {
        proposalId: propDisable.id,
        requestId: randomUUID(),
        decision: "approve",
      });
      assert.equal(revDisable.status, "approved");
      assert.equal(
        (
          await owner.query("SELECT is_active FROM admin_users WHERE id=$1", [
            target.accountId,
          ])
        ).rows[0].is_active,
        false,
      );
      await target.session.agent.get(base + "/auth/me").expect(401);
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: target.email, password })
        .expect(401);
      assert.deepEqual(
        (await snapshot(target.accountId)).memberships,
        orgBefore.memberships,
      );

      const propRestore = await command(operator, "propose", {
        accountId: target.accountId,
        requestId: randomUUID(),
        action: "restore_account",
        reason: "account_restoration",
      });
      const revRestore = await command(second, "review", {
        proposalId: propRestore.id,
        requestId: randomUUID(),
        decision: "approve",
      });
      assert.equal(revRestore.status, "approved");
      assert.equal(
        (
          await owner.query("SELECT is_active FROM admin_users WHERE id=$1", [
            target.accountId,
          ])
        ).rows[0].is_active,
        true,
      );
      await login(target.email, password);

      const nextEmail = `recovered-${randomUUID().slice(0, 8)}@example.org`;
      const propLostContact = await command(operator, "propose", {
        accountId: target.accountId,
        requestId: randomUUID(),
        action: "lost_contact_recovery",
        reason: "lost_contact",
        newEmail: nextEmail,
      });
      const revLostContact = await command(second, "review", {
        proposalId: propLostContact.id,
        requestId: randomUUID(),
        decision: "approve",
      });
      assert.equal(revLostContact.status, "approved");
      assert.equal(
        (
          await owner.query("SELECT email FROM admin_users WHERE id=$1", [
            target.accountId,
          ])
        ).rows[0].email,
        nextEmail,
      );
      await login(nextEmail, password);
      const nextRecovery = await recover({ ...target, email: nextEmail });
      await login(nextEmail, nextRecovery);

      await owner.query(
        "UPDATE admin_users SET mfa_enabled=true,mfa_secret_encrypted='v2:enc-secret',mfa_enrolled_at=clock_timestamp(),mfa_last_counter=5 WHERE id=$1",
        [target.accountId],
      );
      const propMfaReset = await command(operator, "propose", {
        accountId: target.accountId,
        requestId: randomUUID(),
        action: "mfa_reset",
        reason: "lost_mfa_device",
      });
      const revMfaReset = await command(second, "review", {
        proposalId: propMfaReset.id,
        requestId: randomUUID(),
        decision: "approve",
      });
      assert.equal(revMfaReset.status, "approved");
      const mfaAfter = (
        await owner.query(
          "SELECT mfa_enabled,mfa_secret_encrypted,mfa_enrolled_at,mfa_last_counter FROM admin_users WHERE id=$1",
          [target.accountId],
        )
      ).rows[0];
      assert.equal(mfaAfter.mfa_enabled, false);
      assert.equal(mfaAfter.mfa_secret_encrypted, null);
      assert.equal(mfaAfter.mfa_enrolled_at, null);
      assert.equal(Number(mfaAfter.mfa_last_counter), -1);
      await assert.rejects(
        db.query("SELECT * FROM web_account_lifecycle_proposals"),
        (e: any) => e.code === "42501",
      );
      await denied(
        command(operator, "propose", {
          accountId: tech.id,
          requestId: randomUUID(),
          action: "disable_account",
          reason: "policy_violation",
        }),
        409,
      );
    },
  );
  console.log("9 web-account protection scenarios passed");
}
