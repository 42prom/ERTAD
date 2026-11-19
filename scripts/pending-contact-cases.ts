import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import {
  contactCommand,
  revokePendingContact,
  confirmContact,
  activateInvitation,
} from "../backend/src/modules/identity/invitations";
import { deliverSecurityMailBatch } from "../backend/src/modules/identity/mailDelivery";
import { SecurityService } from "../backend/src/services/security";
export async function verifyPendingContacts({
  ctx,
  realApproved,
  send,
  sent,
  job,
}: any) {
  if(process.argv.includes('--browser-only')){
    await (await import('./pending-contact-browser')).verifyPendingContactBrowser(ctx);
    return;
  }
  const { owner, db, app, access, sessions, org, a, denied, check } = ctx,
    base = "/api/v1/admin",
    origin = "http://localhost:15173";
  const revoke = (id: string, index = 2) =>
    revokePendingContact(sessions[index], { organizationId: org, id });
  const first = await realApproved();
  await check(
    "pending-contact revocation enforces scope, Origin, CSRF, fresh password and strict target input",
    async () => {
      await denied(revoke(first.id, 4));
      const agent = request.agent(app),
        login = await agent
          .post(base + "/auth/login")
          .set("Origin", origin)
          .send({
            email: access.accounts[2].email,
            password: access.accounts[2].password,
          })
          .expect(200);
      const input = { organizationId: org, id: first.id };
      await agent
        .post(base + "/invitations/contact/revoke")
        .set("Origin", origin)
        .send(input)
        .expect(403);
      await agent
        .post(base + "/invitations/contact/revoke")
        .set("Origin", "https://foreign.example.test")
        .set("X-Admin-CSRF", login.body.csrfToken)
        .send(input)
        .expect(403);
      await agent
        .post(base + "/invitations/contact/revoke")
        .set("Origin", origin)
        .set("X-Admin-CSRF", login.body.csrfToken)
        .send(input)
        .expect(428);
      await sessions[2].agent
        .post(base + "/invitations/contact/revoke")
        .set("Origin", origin)
        .set("X-Admin-CSRF", sessions[2].csrf)
        .send({ ...input, memberId: first.member })
        .expect(400);
      const synthetic = (
        await owner.query(
          "SELECT id FROM web_invite_contacts WHERE member_id=$1 AND source='synthetic'",
          [first.member],
        )
      ).rows[0].id;
      await denied(revoke(synthetic));
      await denied(revoke(randomUUID()));
    },
  );
  await check(
    "an unapproved wrong address can be replaced and old retries cannot revoke the replacement",
    async () => {
      const original = await ctx.contact(),
        input = {
          organizationId: org,
          unitId: original.unit,
          memberId: original.member,
          requestId: randomUUID(),
          email: "wrong-" + randomBytes(5).toString("hex") + "@example.test",
        };
      const old = await contactCommand(sessions[2], "create", input);
      await revoke(old.id);
      const stamp = (
        await owner.query(
          "SELECT revoked_at FROM web_invite_contacts WHERE id=$1",
          [old.id],
        )
      ).rows[0].revoked_at;
      const next = await contactCommand(sessions[2], "create", {
        ...input,
        requestId: randomUUID(),
        email: "correct-" + randomBytes(5).toString("hex") + "@example.test",
      });
      assert.notEqual(old.id, next.id);
      await revoke(old.id);
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM web_invite_contacts WHERE id=$1",
            [next.id],
          )
        ).rows[0].revoked_at,
        null,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM web_invite_contacts WHERE id=$1",
            [old.id],
          )
        ).rows[0].revoked_at.toISOString(),
        stamp.toISOString(),
      );
      assert.equal(
        Number(
          (
            await owner.query(
              "SELECT count(*) n FROM audit_log WHERE event_type='WEB_CONTACT_REVOKED' AND payload::jsonb->>'contactId'=$1",
              [old.id],
            )
          ).rows[0].n,
        ),
        1,
      );
    },
  );
  await check(
    "revoking an approved contact invalidates its delivered proof without changing another contact",
    async () => {
      const c = await realApproved();
      await deliverSecurityMailBatch(send);
      const proof = sent.find(
        (m: any) => m.id === c.invite && m.purpose === "contact",
      );
      assert(proof);
      const other = await job(first.invite);
      await revoke(c.id);
      await denied(confirmContact({ id: proof.id, token: proof.token }), 409);
      assert(
        (
          await owner.query(
            "SELECT revoked_at FROM web_invitations WHERE id=$1",
            [c.invite],
          )
        ).rows[0].revoked_at,
      );
      assert.deepEqual(await job(first.invite), other);
    },
  );
  await check(
    "revocation cancels queued retry work and immediately purges its encrypted token",
    async () => {
      const c = await realApproved();
      await deliverSecurityMailBatch(async () => "retry");
      const before = await job(c.invite);
      assert.equal(before.state, "retry");
      assert(before.token_cipher);
      await revoke(c.id);
      const after = await job(c.invite);
      assert.equal(after.state, "cancelled");
      assert.equal(after.token_cipher, null);
      const count = sent.length;
      await deliverSecurityMailBatch(send);
      assert.equal(sent.length, count);
    },
  );
  await check(
    "activated accounts and their verified contacts cannot be changed by this operation",
    async () => {
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
        password: "Synthetic-contact-account-582!",
      });
      const snapshot = async () =>
        (
          await owner.query(
            "SELECT a.* FROM admin_users a JOIN web_invitations i ON i.account_id=a.id WHERE i.id=$1",
            [c.invite],
          )
        ).rows[0];
      const before = await snapshot();
      await denied(revoke(c.id));
      assert.deepEqual(await snapshot(), before);
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM web_invite_contacts WHERE id=$1",
            [c.id],
          )
        ).rows[0].revoked_at,
        null,
      );
    },
  );
  await check(
    "audit outage rolls back contact, invitation and queued-token revocation together",
    async () => {
      const c = await realApproved();
      await deliverSecurityMailBatch(async () => "retry");
      const before = await job(c.invite),
        original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        if (event === "WEB_CONTACT_REVOKED")
          throw Error("synthetic audit outage");
        return original(client, event, data);
      };
      try {
        await assert.rejects(revoke(c.id));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM web_invite_contacts WHERE id=$1",
            [c.id],
          )
        ).rows[0].revoked_at,
        null,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM web_invitations WHERE id=$1",
            [c.invite],
          )
        ).rows[0].revoked_at,
        null,
      );
      assert.deepEqual(await job(c.invite), before);
    },
  );
  await check(
    "post-audit eligibility loss denies the result and rolls back every change",
    async () => {
      const c = await realApproved(),
        original = SecurityService.logAuditEventInTransaction;
      await owner.query(
        "CREATE FUNCTION ertad.test_contact_suspend(target uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ UPDATE ertad.member_users SET status='suspended' WHERE id=target $$; GRANT EXECUTE ON FUNCTION ertad.test_contact_suspend(uuid) TO ertad_app",
      );
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        await original(client, event, data);
        if (event === "WEB_CONTACT_REVOKED")
          await client.query("SELECT ertad.test_contact_suspend($1)", [
            c.member,
          ]);
      };
      try {
        await denied(revoke(c.id));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query("DROP FUNCTION ertad.test_contact_suspend(uuid)");
      }
      assert.equal(
        (
          await owner.query("SELECT status FROM member_users WHERE id=$1", [
            c.member,
          ])
        ).rows[0].status,
        "active",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM web_invite_contacts WHERE id=$1",
            [c.id],
          )
        ).rows[0].revoked_at,
        null,
      );
    },
  );
  await check(
    "activation and contact revocation serialize with one winner and runtime storage stays private",
    async () => {
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
      const outcomes = await Promise.allSettled([
        activateInvitation({
          id: activation.id,
          token: activation.token,
          password: "Synthetic-contact-race-592!",
        }),
        revoke(c.id),
      ]);
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
      const row = (
        await owner.query(
          "SELECT i.consumed_at,c.revoked_at,m.web_account_id FROM web_invitations i JOIN web_invite_contacts c ON c.id=i.contact_id AND c.organization_id=i.organization_id JOIN member_users m ON m.id=c.member_id WHERE i.id=$1",
          [c.invite],
        )
      ).rows[0];
      if (row.consumed_at) {
        assert(row.web_account_id);
        assert.equal(row.revoked_at, null);
      } else {
        assert(row.revoked_at);
        assert.equal(row.web_account_id, null);
      }
      await assert.rejects(
        db.query("UPDATE web_invite_contacts SET revoked_at=NULL"),
        (e: any) => e.code === "42501",
      );
    },
  );
  if (process.argv.includes("--browser"))
    await (
      await import("./pending-contact-browser")
    ).verifyPendingContactBrowser(ctx);
  console.log("8 pending-contact revocation scenarios passed");
}
