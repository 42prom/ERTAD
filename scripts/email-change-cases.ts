import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { ownEmailCommand } from "../backend/src/modules/identity/emailChange";
import {
  activateInvitation,
  confirmContact,
} from "../backend/src/modules/identity/invitations";
import { deliverSecurityMailBatch } from "../backend/src/modules/identity/mailDelivery";
import {
  requestRecovery,
  completeRecovery,
} from "../backend/src/modules/identity/recovery";
import { selfAccountCommand } from "../backend/src/modules/identity/selfAccount";
import { createAdminSession } from "../backend/src/services/adminSession";
import { SecurityService } from "../backend/src/services/security";
export async function verifyEmailChanges({
  ctx,
  realApproved,
  send,
  sent,
  job,
}: any) {
  const { owner, db, app, sessions, check, denied } = ctx,
    origin = "http://localhost:15173",
    base = "/api/v1/admin",
    password = "Synthetic-email-change-pass-573!";
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  async function login(email: string, secret = password) {
    const agent = request.agent(app),
      response = await agent
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email, password: secret })
        .expect(200);
    const identity = (
      await owner.query(
        'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1 AND csrf_token_hash=$2',
        [response.body.user.id, hash(response.body.csrfToken)],
      )
    ).rows[0];
    return {
      ...identity,
      agent,
      csrf: response.body.csrfToken,
      accountId: response.body.user.id,
    };
  }
  async function step(session: any, secret = password) {
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
    const proof = sent.find(
      (m: any) => m.id === c.invite && m.purpose === "contact",
    );
    await confirmContact({ id: proof.id, token: proof.token });
    await deliverSecurityMailBatch(send);
    const activation = sent.find(
      (m: any) => m.id === c.invite && m.purpose === "invitation",
    );
    await activateInvitation({
      id: activation.id,
      token: activation.token,
      password,
    });
    const session = await login(c.email);
    await step(session);
    return { ...c, session, accountId: session.accountId };
  }
  const read = (session: any) => ownEmailCommand(session, "read", {});
  async function ask(
    f: any,
    newEmail = "changed-" + randomUUID() + "@example.test",
    key = randomUUID(),
  ) {
    const result = await ownEmailCommand(f.session, "request", {
      requestId: key,
      newEmail,
    });
    return { id: result.id, newEmail, key };
  }
  async function proofFor(change: any) {
    await deliverSecurityMailBatch(send);
    const message = sent.find(
      (m: any) => m.id === change.id && m.purpose === "email_change",
    );
    assert(message);
    return message;
  }
  const finish = (f: any, change: any, proof: any) =>
    ownEmailCommand(f.session, "confirm", {
      id: change.id,
      newEmail: change.newEmail,
      token: proof.token,
    });
  const f = await fixture();
  if (process.argv.includes("--browser-only")) {
    await (
      await import("./email-change-browser")
    ).verifyEmailChangeBrowser({ ctx, recipient: f, send, sent, password });
    return;
  }
  await check(
    "own email status and request enforce verified binding, current session, CSRF and target-free input",
    async () => {
      const state = await read(f.session);
      assert.equal(state.available, true);
      assert.equal(state.currentEmail, f.email);
      assert.equal(state.pending, null);
      assert.equal((await read(sessions[2])).available, false);
      await denied(
        ownEmailCommand(sessions[2], "request", {
          requestId: randomUUID(),
          newEmail: "unbound@example.test",
        }),
        409,
      );
      const other = await login(f.email),
        body = { requestId: randomUUID(), newEmail: "new@example.test" };
      await other.agent
        .post(base + "/auth/security/email/request")
        .set("Origin", origin)
        .send(body)
        .expect(403);
      await other.agent
        .post(base + "/auth/security/email/request")
        .set("Origin", origin)
        .set("X-Admin-CSRF", other.csrf)
        .send(body)
        .expect(428);
      await f.session.agent
        .post(base + "/auth/security/email/request")
        .set("Origin", "https://foreign.example.test")
        .set("X-Admin-CSRF", f.session.csrf)
        .send(body)
        .expect(403);
      await f.session.agent
        .post(base + "/auth/security/email/request")
        .set("Origin", origin)
        .set("X-Admin-CSRF", f.session.csrf)
        .send({ ...body, accountId: other.accountId })
        .expect(400);
      await denied(
        ownEmailCommand(f.session, "request", {
          requestId: randomUUID(),
          newEmail: "x@example.test\r\nBcc:y@example.test",
        }),
        400,
      );
      for (const newEmail of [
        ".leading@example.test",
        "consecutive..dots@example.test",
        "valid@-invalid.example.test",
      ])
        await denied(
          ownEmailCommand(f.session, "request", {
            requestId: randomUUID(),
            newEmail,
          }),
          400,
        );
    },
  );
  await check(
    "requests/cancellation bind immutable IDs, preserve the old address and never cancel a replacement",
    async () => {
      const c = await fixture(),
        change = await ask(c);
      assert.equal((await ask(c, change.newEmail, change.key)).id, change.id);
      await denied(ask(c, "different@example.test", change.key), 409);
      const status = await read(c.session);
      assert.equal(status.currentEmail, c.email);
      assert.equal(status.pending.newEmail, change.newEmail);
      assert(!JSON.stringify(status).includes("token"));
      assert(!JSON.stringify(status).includes("fingerprint"));
      await denied(
        ownEmailCommand(f.session, "cancel", { id: change.id }),
        409,
      );
      const proof = await proofFor(change);
      await ownEmailCommand(c.session, "cancel", { id: change.id });
      await ownEmailCommand(c.session, "cancel", { id: change.id });
      const replacement = await ask(c);
      await ownEmailCommand(c.session, "cancel", { id: change.id });
      assert.equal((await read(c.session)).pending.id, replacement.id);
      await denied(finish(c, change, proof), 409);
      assert.equal(
        Number(
          (
            await owner.query(
              "SELECT count(*) n FROM audit_log WHERE event_type='WEB_EMAIL_CHANGE_CANCELLED' AND payload::jsonb->>'requestId'=$1",
              [change.id],
            )
          ).rows[0].n,
        ),
        1,
      );
      await ownEmailCommand(c.session, "cancel", { id: replacement.id });
    },
  );
  let firstChanged: string;
  await check(
    "proof plus own password/session changes the login address atomically and invalidates old recovery/sessions",
    async () => {
      const second = await login(f.email),
        change = await ask(f),
        proof = await proofFor(change);
      await request(app)
        .post(base + "/auth/security/email/confirm")
        .set("Origin", origin)
        .send({ id: change.id, newEmail: change.newEmail, token: proof.token })
        .expect(401);
      await denied(
        ownEmailCommand(sessions[2], "confirm", {
          id: change.id,
          newEmail: change.newEmail,
          token: proof.token,
        }),
        409,
      );
      await requestRecovery({ email: f.email });
      await deliverSecurityMailBatch(send);
      const recovery = sent.find(
        (m: any) => m.purpose === "recovery" && m.email === f.email,
      );
      assert(recovery);
      const before = (
        await owner.query(
          "SELECT password_hash,role,mfa_enabled FROM admin_users WHERE id=$1",
          [f.accountId],
        )
      ).rows[0];
      const memberBefore = (
        await owner.query(
          "SELECT * FROM memberships WHERE user_id=$1 ORDER BY id",
          [f.member],
        )
      ).rows;
      const response = await f.session.agent
        .post(base + "/auth/security/email/confirm")
        .set("Origin", origin)
        .set("X-Admin-CSRF", f.session.csrf)
        .send({ id: change.id, newEmail: change.newEmail, token: proof.token })
        .expect(200);
      assert.deepEqual(response.body, { changed: true });
      assert(response.headers["set-cookie"]);
      await second.agent.get(base + "/auth/me").expect(401);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT password_hash,role,mfa_enabled FROM admin_users WHERE id=$1",
            [f.accountId],
          )
        ).rows[0],
        before,
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT * FROM memberships WHERE user_id=$1 ORDER BY id",
            [f.member],
          )
        ).rows,
        memberBefore,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT email FROM web_invite_contacts WHERE id=$1",
            [f.id],
          )
        ).rows[0].email,
        f.email,
      );
      await denied(
        completeRecovery({
          id: recovery.id,
          token: recovery.token,
          password: "Synthetic-old-link-denied-592!",
        }),
        409,
      );
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: f.email, password })
        .expect(401);
      f.session = await login(change.newEmail);
      await step(f.session);
      firstChanged = change.newEmail;
      assert.equal((await read(f.session)).currentEmail, change.newEmail);
      await denied(finish(f, change, proof), 409);
      const notice = await job(change.id, "email_changed");
      assert.equal(notice.state, "queued");
      await deliverSecurityMailBatch(send);
      const message = sent.find(
        (m: any) => m.id === change.id && m.purpose === "email_changed",
      );
      assert.equal(message.email, f.email);
    },
  );
  await check(
    "a later change preserves verified continuity and queues its old-address notice while transport is paused",
    async () => {
      const change = await ask(f),
        proof = await proofFor(change);
      await owner.query(
        "UPDATE mail_policy_proposals SET delivery_enabled=false WHERE status='approved'",
      );
      try {
        await finish(f, change, proof);
        assert.equal((await job(change.id, "email_changed")).state, "queued");
      } finally {
        await owner.query(
          "UPDATE mail_policy_proposals SET delivery_enabled=true WHERE status='approved'",
        );
      }
      await deliverSecurityMailBatch(send);
      assert.equal(
        sent.find(
          (m: any) => m.id === change.id && m.purpose === "email_changed",
        ).email,
        firstChanged,
      );
      f.session = await login(change.newEmail);
      await step(f.session);
      assert.equal(
        (await selfAccountCommand(f.session, "recovery", {})).available,
        true,
      );
      await requestRecovery({ email: change.newEmail });
      await deliverSecurityMailBatch(send);
      assert(
        sent.some(
          (m: any) => m.purpose === "recovery" && m.email === change.newEmail,
        ),
      );
    },
  );
  await check(
    "expiry and intervening password rotation invalidate old email proofs",
    async () => {
      const c = await fixture(),
        expired = await ask(c),
        proof = await proofFor(expired);
      await owner.query(
        "UPDATE web_account_email_changes SET expires_at=created_at+interval '1 millisecond' WHERE id=$1",
        [expired.id],
      );
      await denied(finish(c, expired, proof), 409);
      await ownEmailCommand(c.session, "cancel", { id: expired.id });
      const change = await ask(c),
        nextProof = await proofFor(change),
        replacement = "Synthetic-email-fingerprint-rotation-594!";
      await selfAccountCommand(c.session, "password", {
        newPassword: replacement,
      });
      c.session = await login(c.email, replacement);
      await step(c.session, replacement);
      await denied(finish(c, change, nextProof), 409);
      const newest = await ask(c);
      assert.notEqual(newest.id, change.id);
      assert(
        (
          await owner.query(
            "SELECT revoked_at FROM web_account_email_changes WHERE id=$1",
            [change.id],
          )
        ).rows[0].revoked_at,
      );
    },
  );
  await check(
    "another account cannot consume a proof and proof possession cannot overwrite an existing login address",
    async () => {
      const c = await fixture(),
        change = await ask(c, f.session ? firstChanged : "unused@example.test");
      // Use the currently occupied address after the second change.
      const occupied = (await read(f.session)).currentEmail;
      await ownEmailCommand(c.session, "cancel", { id: change.id });
      const blocked = await ask(c, occupied),
        proof = await proofFor(blocked);
      await denied(
        ownEmailCommand(f.session, "confirm", {
          id: blocked.id,
          newEmail: blocked.newEmail,
          token: proof.token,
        }),
        409,
      );
      await denied(finish(c, blocked, proof), 409);
      assert.equal((await read(c.session)).currentEmail, c.email);
    },
  );
  await check(
    "audit outage and post-audit changes roll back address, session, recovery and notification state",
    async () => {
      const c = await fixture(),
        key = randomUUID(),
        newEmail = "audited-" + randomUUID() + "@example.test",
        original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        if (event === "WEB_EMAIL_CHANGE_REQUESTED")
          throw Error("synthetic audit outage");
        return original(client, event, data);
      };
      try {
        await assert.rejects(ask(c, newEmail, key));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal((await read(c.session)).pending, null);
      const change = await ask(c, newEmail, key),
        proof = await proofFor(change);
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        if (event === "WEB_EMAIL_CHANGED")
          throw Error("synthetic audit outage");
        return original(client, event, data);
      };
      try {
        await assert.rejects(finish(c, change, proof));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      await owner.query(
        "CREATE FUNCTION ertad.test_email_tamper(mode text,account uuid,member uuid,sid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF mode='member' THEN UPDATE ertad.member_users SET status='suspended' WHERE id=member; ELSIF mode='session' THEN UPDATE ertad.admin_sessions SET revoked_at=NULL WHERE id=sid; ELSE UPDATE ertad.admin_users SET email='tampered@example.test' WHERE id=account; END IF; END $$; GRANT EXECUTE ON FUNCTION ertad.test_email_tamper(text,uuid,uuid,uuid) TO ertad_app",
      );
      try {
        for (const mode of ["member", "session", "email"]) {
          SecurityService.logAuditEventInTransaction = async (
            client,
            event,
            data,
          ) => {
            await original(client, event, data);
            if (event === "WEB_EMAIL_CHANGED")
              await client.query(
                "SELECT ertad.test_email_tamper($1,$2,$3,$4)",
                [mode, c.accountId, c.member, c.session.sessionId],
              );
          };
          await denied(finish(c, change, proof), 409);
        }
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query(
          "DROP FUNCTION ertad.test_email_tamper(text,uuid,uuid,uuid)",
        );
      }
      assert.equal((await read(c.session)).currentEmail, c.email);
      assert.equal(await job(change.id, "email_changed"), undefined);
      await finish(c, change, proof);
    },
  );
  await check(
    "recovery and email confirmation race with one winner; stale email login proofs and direct SQL writes fail",
    async () => {
      const c = await fixture(),
        change = await ask(c),
        proof = await proofFor(change);
      await requestRecovery({ email: c.email });
      await deliverSecurityMailBatch(send);
      const recovery = sent.find(
        (m: any) => m.purpose === "recovery" && m.email === c.email,
      );
      const outcomes = await Promise.allSettled([
        finish(c, change, proof),
        completeRecovery({
          id: recovery.id,
          token: recovery.token,
          password: "Synthetic-racing-recovery-593!",
        }),
      ]);
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
      const account = (
        await owner.query(
          "SELECT email,password_hash FROM admin_users WHERE id=$1",
          [f.accountId],
        )
      ).rows[0];
      let issued = false;
      await assert.rejects(
        createAdminSession(
          f.accountId,
          {} as any,
          {
            append() {
              issued = true;
            },
          } as any,
          account.password_hash,
          f.email,
        ),
        (error: any) => error.statusCode === 401,
      );
      assert.equal(issued, false);
      for (const sql of [
        "SELECT * FROM web_account_email_changes",
        "UPDATE admin_users SET email='forbidden@example.test'",
      ])
        await assert.rejects(db.query(sql), (e: any) => e.code === "42501");
      const audits = (
        await owner.query(
          "SELECT payload::text AS body FROM audit_log WHERE event_type LIKE 'WEB_EMAIL_%'",
        )
      ).rows;
      for (const { body } of audits) {
        assert(!body.includes("@example.test"));
        assert(!body.includes("fingerprint"));
        for (const message of sent) assert(!body.includes(message.token));
      }
    },
  );
  console.log("8 own-email change scenarios passed");
}
