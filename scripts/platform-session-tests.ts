import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Client } from "pg";
import request from "supertest";
import { enablePlatformSessionResponse } from "./platform-fixture";
import { platformCommand } from "../backend/src/modules/security/platform";
import { SecurityService } from "../backend/src/services/security";

export async function testPlatformSessions(
  app: Express,
  owner: Client,
  technical: { id: string; email: string; password: string },
  organizationalId: string,
  check: (name: string, fn: () => Promise<void>) => Promise<void>,
) {
  const origin = "http://localhost:15173",
    base = "/api/v1/admin";
  // Avoid exhausting the shared password limiter; credentials are still verified through real HTTP login.
  const tech = request.agent(app),
    member = request.agent(app);
  const login = await tech
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: technical.id })
    .expect(200);
  const csrf = login.body.csrfToken;
  await member
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: organizationalId })
    .expect(200);
  const own = (
    await owner.query(
      'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1 ORDER BY created_at DESC LIMIT 1',
      [technical.id],
    )
  ).rows[0];
  const target = (
    await owner.query(
      "SELECT id FROM admin_sessions WHERE admin_user_id=$1 ORDER BY created_at DESC LIMIT 1",
      [organizationalId],
    )
  ).rows[0].id;
  const command = (operation: "sessions" | "revoke", input: unknown = {}) =>
    platformCommand(own, operation, input);
  const denied = (promise: Promise<unknown>, code = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === code);
  const mutation = {
    sessionId: target,
    requestId: randomUUID(),
    reason: "suspected_compromise",
  };
  const post = (input = mutation) =>
    tech
      .post(base + "/platform/sessions/revoke")
      .set("Origin", origin)
      .set("X-Admin-CSRF", csrf)
      .send(input);
  await check(
    "session permissions are explicit and development upgrade preserves expiry and credentials",
    async () => {
      await denied(command("sessions"));
      const before = (
        await owner.query(
          "SELECT valid_until,revoked_at FROM platform_accounts WHERE admin_user_id=$1",
          [technical.id],
        )
      ).rows[0];
      await owner.query("BEGIN");
      await enablePlatformSessionResponse(owner, technical.id);
      await owner.query("COMMIT");
      assert.deepEqual(
        (
          await owner.query(
            "SELECT valid_until,revoked_at FROM platform_accounts WHERE admin_user_id=$1",
            [technical.id],
          )
        ).rows[0],
        before,
      );
      await owner.query("BEGIN");
      assert.equal(
        await enablePlatformSessionResponse(owner, technical.id),
        false,
      );
      await owner.query("COMMIT");
      await member.get(base + "/platform/sessions").expect(403);
      await request(app)
        .get(base + "/platform/sessions")
        .set("Authorization", "Bearer mobile-only")
        .expect(401);
      await post().expect(428);
      await tech
        .post(base + "/auth/step-up")
        .set("Origin", origin)
        .set("X-Admin-CSRF", csrf)
        .send({ password: technical.password })
        .expect(200);
    },
  );
  await check(
    "session disclosure is bounded and excludes credentials, identity and current-session response",
    async () => {
      const data = await command("sessions");
      assert.ok(
        data.items.some((i: any) => i.id === own.sessionId && i.current),
      );
      assert.ok(
        data.items.some(
          (i: any) => i.id === target && i.kind === "organization",
        ),
      );
      assert.deepEqual(
        Object.keys(data.items[0]).sort(),
        [
          "id",
          "kind",
          "current",
          "createdAt",
          "lastSeenAt",
          "expiresAt",
        ].sort(),
      );
      const serialized = JSON.stringify(data);
      for (const forbidden of [
        technical.email,
        technical.password,
        own.sessionTokenHash,
        organizationalId,
        technical.id,
      ])
        assert.ok(!serialized.includes(forbidden));
      assert.ok(
        (await command("sessions", { kind: "technical" })).items.every(
          (i: any) => i.kind === "technical",
        ),
      );
      await denied(command("sessions", { before: "bad" }), 400);
      await denied(
        command("revoke", { ...mutation, sessionId: own.sessionId }),
        400,
      );
      await denied(command("revoke", { ...mutation, extra: true }), 400);
      await tech
        .post(base + "/platform/sessions/revoke")
        .set("Origin", origin)
        .send(mutation)
        .expect(403);
      await tech
        .post(base + "/platform/sessions/revoke")
        .set("Origin", "https://foreign.invalid")
        .set("X-Admin-CSRF", csrf)
        .send(mutation)
        .expect(403);
    },
  );
  await check(
    "session changes and receipts roll back on audit failure or expiry during audit",
    async () => {
      const original = SecurityService.logAuditEventInTransaction;
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw Error("synthetic audit failure");
        };
        await assert.rejects(
          command("revoke", mutation),
          /synthetic audit failure/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM admin_sessions WHERE id=$1",
            [target],
          )
        ).rows[0].revoked_at,
        null,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT 1 FROM platform_session_responses WHERE request_id=$1",
            [mutation.requestId],
          )
        ).rowCount,
        0,
      );
      try {
        SecurityService.logAuditEventInTransaction = async (
          client,
          event,
          payload,
        ) => {
          await original(client, event, payload);
          if (event === "PLATFORM_SESSION_REVOKED")
            await client.query(
              "UPDATE admin_sessions SET step_up_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
              [own.sessionId],
            );
        };
        await denied(command("revoke", mutation), 428);
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM admin_sessions WHERE id=$1",
            [target],
          )
        ).rows[0].revoked_at,
        null,
      );
      try {
        SecurityService.logAuditEventInTransaction = async (
          client,
          event,
          payload,
        ) => {
          await original(client, event, payload);
          if (event === "PLATFORM_SESSION_REVOKED")
            await client.query(
              "UPDATE platform_accounts SET valid_from=now()-interval '1 day',valid_until=clock_timestamp()-interval '1 second' WHERE admin_user_id=$1",
              [technical.id],
            );
        };
        await denied(command("revoke", mutation));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT revoked_at FROM admin_sessions WHERE id=$1",
            [target],
          )
        ).rows[0].revoked_at,
        null,
      );
    },
  );
  await check(
    "concurrent exact retry revokes once, disables affected client, and cannot reuse a key for another action",
    async () => {
      const replies = await Promise.all([
        command("revoke", mutation),
        command("revoke", mutation),
      ]);
      assert.deepEqual(replies[0], replies[1]);
      await member.get(base + "/auth/me").expect(401);
      const again = await post().expect(200);
      assert.deepEqual(again.body, replies[0]);
      assert.equal(
        (
          await owner.query(
            "SELECT 1 FROM audit_log WHERE event_type='PLATFORM_SESSION_REVOKED' AND payload::jsonb->>'requestId'=$1",
            [mutation.requestId],
          )
        ).rowCount,
        1,
      );
      await post({ ...mutation, reason: "session_hygiene" }).expect(409);
      await post({ ...mutation, requestId: randomUUID() }).expect(409);
      await post({
        ...mutation,
        requestId: randomUUID(),
        sessionId: randomUUID(),
      }).expect(404);
      await owner.query(
        "UPDATE platform_accounts SET permissions=array_remove(permissions,'platform.sessions.revoke') WHERE admin_user_id=$1",
        [technical.id],
      );
      await post().expect(403);
      await owner.query("BEGIN");
      await enablePlatformSessionResponse(owner, technical.id);
      await owner.query("COMMIT");
    },
  );
  await check(
    "session cursor has no duplicate rows and filters apply before the page limit",
    async () => {
      // Synthetic sessions are never browser credentials; cleanup is isolated to this disposable DB.
      const seeded = (
        await owner.query(
          `INSERT INTO admin_sessions(admin_user_id,token_hash,csrf_token_hash,csrf_token_encrypted,idle_expires_at,absolute_expires_at)
      SELECT $1,encode(sha256(gen_random_uuid()::text::bytea),'hex'),repeat('0',64),'v2:synthetic',now()+interval '1 hour',now()+interval '1 hour' FROM generate_series(1,28) RETURNING id`,
          [organizationalId],
        )
      ).rows.map((r) => r.id);
      try {
        const first = await command("sessions", { kind: "organization" });
        assert.equal(first.items.length, 25);
        assert.ok(first.nextBefore);
        const second = await command("sessions", {
          kind: "organization",
          before: first.nextBefore,
        });
        assert.equal(
          new Set([...first.items, ...second.items].map((i: any) => i.id)).size,
          first.items.length + second.items.length,
        );
        assert.ok(second.items.length >= 3);
        await owner.query(
          "UPDATE platform_accounts SET revoked_at=now() WHERE admin_user_id=$1",
          [technical.id],
        );
        await denied(command("sessions"));
        await owner.query("BEGIN");
        assert.equal(
          await enablePlatformSessionResponse(owner, technical.id),
          false,
        );
        await owner.query("COMMIT");
      } finally {
        await owner.query(
          "DELETE FROM admin_sessions WHERE id=ANY($1::uuid[])",
          [seeded],
        );
        await owner.query(
          "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
          [technical.id],
        );
      }
    },
  );
}
