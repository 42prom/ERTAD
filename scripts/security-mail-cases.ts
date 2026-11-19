import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import request from "supertest";
import {
  contactCommand,
  confirmContact,
  activateInvitation,
} from "../backend/src/modules/identity/invitations";
import { deliverSecurityMailBatch } from "../backend/src/modules/identity/mailDelivery";
import {
  requestRecovery,
  completeRecovery,
} from "../backend/src/modules/identity/recovery";
import { SecurityService } from "../backend/src/services/security";
import { seedPlatformOperator } from "./platform-fixture";
import { encryptSensitiveValue } from "../backend/src/services/secretEncryption";
export async function verifySecurityMail(ctx: any) {
  const {
    owner,
    db,
    app,
    access,
    sessions,
    org,
    a,
    contact,
    cmd,
    invite,
    payload,
    vote,
    denied,
    check,
  } = ctx;
  const origin = "http://localhost:15173",
    base = "/api/v1/admin",
    password = "Synthetic-invitation-pass-582!";
  const digest = (token: string) =>
    createHash("sha256").update(token).digest("hex");
  const tech = await seedPlatformOperator(owner),
    reviewer = await seedPlatformOperator(owner, "reviewer");
  await owner.query(
    "INSERT INTO mail_policy_proposals(proposer_id,request_id,expected_version,provider,mode,sender_name,sender_email,credential_cipher,credential_digest,reason,status,reviewer_id,review_request_id,reviewed_at,version,delivery_enabled,public_origin) VALUES($1,$2,0,'sendgrid','enabled','ERTAD','sender@example.test',$3,repeat('a',64),'provider_change','approved',$4,$5,clock_timestamp(),1,true,'https://ertad.example.test')",
    [
      tech.id,
      randomUUID(),
      encryptSensitiveValue("SG.synthetic-key"),
      reviewer.id,
      randomUUID(),
    ],
  );
  type Message = {
    email: string;
    id: string;
    token: string;
    purpose: "contact" | "invitation" | "recovery" | "email_change" | "email_changed";
  };
  const sent: Message[] = [];
  let outcome: "accepted" | "retry" | "failed" | "uncertain" = "accepted";
  const send = async (_config: unknown, message: Message) => {
    sent.push({ ...message });
    return outcome;
  };
  async function realApproved() {
    const original = await contact();
    const input = {
      organizationId: org,
      unitId: original.unit,
      memberId: original.member,
      requestId: randomUUID(),
      email: "recipient-" + randomBytes(6).toString("hex") + "@example.test",
    };
    const saved = await contactCommand(sessions[2], "create", input);
    assert.equal(
      (await contactCommand(sessions[2], "create", input)).id,
      saved.id,
    );
    await denied(
      contactCommand(sessions[2], "create", {
        ...input,
        email: "other@example.test",
      }),
      409,
    );
    const p = await cmd(
      2,
      "propose",
      payload({ id: saved.id, unit: original.unit }),
    );
    await cmd(3, "vote", vote(p.id));
    return { ...original, id: saved.id, email: input.email, invite: p.id };
  }
  async function job(id: string, purpose = "contact") {
    return (
      await owner.query(
        "SELECT * FROM security_mail_jobs WHERE source_id=$1 AND purpose=$2",
        [id, purpose],
      )
    ).rows[0];
  }
  async function countAccount() {
    return Number(
      (await owner.query("SELECT count(*) n FROM admin_users")).rows[0].n,
    );
  }
  if(process.argv.includes('--account-security')){
    await (await import('./account-security-cases')).verifyAccountSecurity({ctx,tech,reviewer,realApproved,send,sent,job});return;
  }
  if(process.argv.includes('--email-change')){
    await (await import('./email-change-cases')).verifyEmailChanges({ctx,realApproved,send,sent,job});
    return;
  }
  if (process.argv.includes("--contact-revocation")) {
    await (
      await import("./pending-contact-cases")
    ).verifyPendingContacts({ ctx, realApproved, send, sent, job });
    return;
  }
  if (process.argv.includes("--browser-only")) {
    await (await import("./delivery-browser")).verifyDeliveryBrowser(ctx, send);
    return;
  }
  const first = await realApproved();
  await check(
    "contact creation is scoped, bounded and cannot silently bind or activate",
    async () => {
      await denied(
        contactCommand(sessions[4], "create", {
          organizationId: org,
          unitId: a,
          memberId: first.member,
          requestId: randomUUID(),
          email: "foreign@example.test",
        }),
      );
      const input = {
        organizationId: org,
        unitId: a,
        memberId: first.member,
        requestId: randomUUID(),
        email: "x@example.test",
      };
      await sessions[2].agent
        .post(base + "/invitations/contact")
        .set("Origin", origin)
        .send(input)
        .expect(403);
      await sessions[2].agent
        .post(base + "/invitations/contact")
        .set("Origin", origin)
        .set("X-Admin-CSRF", sessions[2].csrf)
        .send({ ...input, email: "x@example.test\r\nBcc: y@example.test" })
        .expect(400);
      assert.equal(
        (
          await owner.query(
            "SELECT verified_at FROM web_invite_contacts WHERE id=$1",
            [first.id],
          )
        ).rows[0].verified_at,
        null,
      );
    },
  );
  await check(
    "reviewed contact proof is recipient-only, single-use and separate from activation",
    async () => {
      const before = await countAccount();
      await deliverSecurityMailBatch(send);
      const proof = sent.find(
        (m) => m.id === first.invite && m.purpose === "contact",
      )!;
      assert(proof);
      assert.equal(proof.email, first.email);
      assert.equal((await job(first.invite)).state, "accepted");
      assert.equal((await job(first.invite)).token_cipher, null);
      await denied(
        activateInvitation({ id: first.invite, token: proof.token, password }),
        409,
      );
      await sessions[2].agent
        .post(base + "/invitations/confirm-email")
        .set("Origin", "https://foreign.example.test")
        .send({ id: proof.id, token: proof.token })
        .expect(403);
      await confirmContact({ id: proof.id, token: proof.token });
      await denied(confirmContact({ id: proof.id, token: proof.token }), 409);
      assert.equal(await countAccount(), before);
      await deliverSecurityMailBatch(send);
      const activation = sent.find(
        (m) => m.id === first.invite && m.purpose === "invitation",
      )!;
      assert(activation);
      assert.notEqual(activation.token, proof.token);
      await activateInvitation({
        id: activation.id,
        token: activation.token,
        password,
      });
      assert.equal(await countAccount(), before + 1);
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: first.email, password })
        .expect(200);
      const old = sent.length;
      await deliverSecurityMailBatch(send);
      assert.equal(sent.length, old);
    },
  );
  await check(
    "verified real contact supports recipient recovery without authority or MFA changes",
    async () => {
      assert.deepEqual(await requestRecovery({ email: first.email }), {
        accepted: true,
      });
      await deliverSecurityMailBatch(send);
      const message = sent.find(
        (m) => m.purpose === "recovery" && m.email === first.email,
      )!;
      assert(message);
      const replacement = "Synthetic-recovery-pass-289!";
      await completeRecovery({
        id: message.id,
        token: message.token,
        password: replacement,
      });
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({ email: first.email, password: replacement })
        .expect(200);
      await denied(
        completeRecovery({ id: message.id, token: message.token, password }),
        409,
      );
    },
  );
  await check(
    "explicit rejection retries with one credential; uncertainty never automatically retries",
    async () => {
      const c = await realApproved();
      outcome = "retry";
      await deliverSecurityMailBatch(send);
      const pending = await job(c.invite);
      assert.equal(pending.state, "retry");
      assert(pending.token_cipher);
      assert.equal(pending.attempts, 1);
      const previous = sent.find((m) => m.id === c.invite)!;
      await owner.query(
        "UPDATE security_mail_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [pending.id],
      );
      // Replace the approved-policy fixture to model a key/configuration rotation.
      await owner.query(
        "UPDATE mail_policy_proposals SET version=2 WHERE status='approved'",
      );
      outcome = "uncertain";
      await deliverSecurityMailBatch(send);
      const messages = sent.filter((m) => m.id === c.invite);
      assert.equal(messages.length, 2);
      assert.equal(messages[1].token, previous.token);
      assert.equal((await job(c.invite)).state, "uncertain");
      assert.equal((await job(c.invite)).policy_version, 2);
      assert.equal((await job(c.invite)).token_cipher, null);
      await deliverSecurityMailBatch(send);
      assert.equal(sent.filter((m) => m.id === c.invite).length, 2);
      outcome = "accepted";
    },
  );
  await check(
    "competing workers claim once and expired sending leases become uncertain",
    async () => {
      const c = await realApproved();
      await Promise.all([
        deliverSecurityMailBatch(send),
        deliverSecurityMailBatch(send),
      ]);
      assert.equal(sent.filter((m) => m.id === c.invite).length, 1);
      const crash = await realApproved(),
        token = randomBytes(32).toString("base64url");
      const id = (
        await db.query("SELECT ertad.security_mail_prepare($1,$2,$3,$4) id", [
          "contact",
          crash.invite,
          digest(token),
          encryptSensitiveValue(token),
        ])
      ).rows[0].id;
      await db.query("SELECT ertad.security_mail_claim($1,$2)", [
        id,
        randomUUID(),
      ]);
      await owner.query(
        "UPDATE security_mail_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
      await deliverSecurityMailBatch(send);
      assert.equal((await job(crash.invite)).state, "uncertain");
      assert.equal(sent.filter((m) => m.id === crash.invite).length, 0);
    },
  );
  await check(
    "revoked invitation and expired proof deny confirmation",
    async () => {
      const c = await realApproved();
      await deliverSecurityMailBatch(send);
      const proof = sent.find((m) => m.id === c.invite)!;
      await invite(2, "revoke", { id: c.invite });
      await denied(confirmContact({ id: proof.id, token: proof.token }), 409);
      const expired = await realApproved();
      await deliverSecurityMailBatch(send);
      await owner.query(
        "UPDATE security_mail_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE source_id=$1",
        [expired.invite],
      );
      const old = sent.find((m) => m.id === expired.invite)!;
      await denied(confirmContact({ id: old.id, token: old.token }), 409);
    },
  );
  await check(
    "audit failure prevents send and uncertain outcome commit cannot cause duplicate sending",
    async () => {
      const c = await realApproved(),
        original = SecurityService.logAuditEventInTransaction;
      await owner.query(
        "CREATE FUNCTION ertad.test_mail_revoke(target uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ UPDATE ertad.web_invite_contacts SET revoked_at=clock_timestamp() WHERE id=target $$; GRANT EXECUTE ON FUNCTION ertad.test_mail_revoke(uuid) TO ertad_app",
      );
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        await original(client, event, data);
        if (event === "SECURITY_MAIL_ATTEMPTED")
          await client.query("SELECT ertad.test_mail_revoke($1)", [c.id]);
      };
      try {
        await assert.rejects(deliverSecurityMailBatch(send));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query("DROP FUNCTION ertad.test_mail_revoke(uuid)");
      }
      assert.equal(sent.filter((m) => m.id === c.invite).length, 0);
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM web_invite_contacts WHERE id=$1",
            [c.id],
          )
        ).rows[0].revoked_at,
        null,
      );
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        if (event === "SECURITY_MAIL_ATTEMPTED")
          throw Error("synthetic audit failure");
        return original(client, event, data);
      };
      try {
        await assert.rejects(deliverSecurityMailBatch(send));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(sent.filter((m) => m.id === c.invite).length, 0);
      assert.equal((await job(c.invite)).state, "queued");
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        if (event === "SECURITY_MAIL_OUTCOME")
          throw Error("synthetic audit failure");
        return original(client, event, data);
      };
      try {
        await assert.rejects(deliverSecurityMailBatch(send));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(sent.filter((m) => m.id === c.invite).length, 1);
      assert.equal((await job(c.invite)).state, "sending");
      await owner.query(
        "UPDATE security_mail_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE source_id=$1",
        [c.invite],
      );
      await deliverSecurityMailBatch(send);
      assert.equal(sent.filter((m) => m.id === c.invite).length, 1);
      const proof = sent.find((m) => m.id === c.invite)!;
      SecurityService.logAuditEventInTransaction = async (
        client,
        event,
        data,
      ) => {
        if (event === "WEB_CONTACT_CONFIRMED")
          throw Error("synthetic proof audit failure");
        return original(client, event, data);
      };
      try {
        await assert.rejects(
          confirmContact({ id: proof.id, token: proof.token }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal((await job(c.invite)).consumed_at, null);
      assert.equal(
        (
          await owner.query(
            "SELECT verified_at FROM web_invite_contacts WHERE id=$1",
            [c.id],
          )
        ).rows[0].verified_at,
        null,
      );
    },
  );
  await check(
    "runtime storage is denied and audits omit destinations and tokens",
    async () => {
      for (const sql of [
        "SELECT * FROM security_mail_jobs",
        "UPDATE web_invite_contacts SET verified_at=clock_timestamp()",
      ])
        await assert.rejects(db.query(sql), (e: any) => e.code === "42501");
      const events = (
        await owner.query(
          "SELECT payload::text AS body FROM audit_log WHERE event_type IN ('SECURITY_MAIL_PREPARED','SECURITY_MAIL_ATTEMPTED','SECURITY_MAIL_OUTCOME','WEB_CONTACT_COMMAND','WEB_CONTACT_CONFIRMED')",
        )
      ).rows;
      for (const event of events) {
        assert(!event.body.includes("@example.test"));
        for (const message of sent) assert(!event.body.includes(message.token));
      }
    },
  );
  if (process.argv.includes("--browser"))
    await (await import("./delivery-browser")).verifyDeliveryBrowser(ctx, send);
  console.log("8 delivery/contact scenarios passed");
}
