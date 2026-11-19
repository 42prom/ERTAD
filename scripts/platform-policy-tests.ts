import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import type { Client } from "pg";
import { enablePlatformPolicy, seedPlatformOperator } from "./platform-fixture";
import { platformCommand } from "../backend/src/modules/security/platform";
import { SecurityService } from "../backend/src/services/security";

export async function testPlatformPolicy(
  app: Express,
  owner: Client,
  technical: { id: string; password: string },
  orgId: string,
  check: (name: string, fn: () => Promise<void>) => Promise<void>,
) {
  const base = "/api/v1/admin",
    origin = "http://localhost:15173",
    tech = request.agent(app),
    org = request.agent(app),
    reviewer = request.agent(app);
  const login = await tech
      .post(base + "/demo/login")
      .set("Origin", origin)
      .send({ accountId: technical.id })
      .expect(200),
    csrf = login.body.csrfToken;
  await org
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: orgId })
    .expect(200);
  await owner.query("BEGIN");
  const second = await seedPlatformOperator(owner, "reviewer");
  await owner.query("COMMIT");
  const reviewLogin = await reviewer
    .post(base + "/auth/login")
    .set("Origin", origin)
    .send({ email: second.email, password: second.password })
    .expect(200);
  const reviewerCsrf = reviewLogin.body.csrfToken;
  const identity = async (id: string) =>
    (
      await owner.query(
        'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1 ORDER BY created_at DESC LIMIT 1',
        [id],
      )
    ).rows[0];
  const own = await identity(technical.id),
    other = await identity(second.id);
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
  const proposal = (version = 0) => ({
    requestId: randomUUID(),
    expectedVersion: version,
    idleSeconds: 300,
    absoluteSeconds: 1800,
    maxSessions: 2,
    reason: "security_tightening",
  });
  const post = (body: unknown) =>
    tech
      .post(base + "/platform/session-policy/propose")
      .set("Origin", origin)
      .set("X-Admin-CSRF", csrf)
      .send(body);
  const review = (id: string, action = "approve", requestId = randomUUID()) =>
    platformCommand(other, "reviewSessionPolicy", {
      proposalId: id,
      action,
      requestId,
    });
  let first = "",
    stale = "",
    firstInput = proposal();
  await check(
    "session policy requires separate grants, strict input, CSRF and password step-up",
    async () => {
      await tech.get(base + "/platform/session-policy").expect(403);
      await org.get(base + "/platform/session-policy").expect(403);
      const before = (
        await owner.query(
          "SELECT valid_until FROM platform_accounts WHERE admin_user_id=$1",
          [technical.id],
        )
      ).rows[0].valid_until;
      await owner.query("BEGIN");
      assert.equal(await enablePlatformPolicy(owner, technical.id), true);
      assert.equal(await enablePlatformPolicy(owner, technical.id), false);
      await owner.query("COMMIT");
      const after = (
        await owner.query(
          "SELECT * FROM platform_accounts WHERE admin_user_id=$1",
          [technical.id],
        )
      ).rows[0];
      assert.equal(after.valid_until.toISOString(), before.toISOString());
      assert(!after.permissions.includes("platform.policy.approve"));
      const baseline = await tech
        .get(base + "/platform/session-policy")
        .expect(200);
      assert.equal(baseline.body.current.version, 0);
      await post(firstInput).expect(428);
      await tech
        .post(base + "/platform/session-policy/propose")
        .set("Origin", origin)
        .send(firstInput)
        .expect(403);
      await tech
        .post(base + "/platform/session-policy/propose")
        .set("Origin", "https://untrusted.example")
        .set("X-Admin-CSRF", csrf)
        .send(firstInput)
        .expect(403);
      await tech
        .post(base + "/auth/step-up")
        .set("Origin", origin)
        .set("X-Admin-CSRF", csrf)
        .send({ password: technical.password })
        .expect(200);
      await reviewer
        .post(base + "/auth/step-up")
        .set("Origin", origin)
        .set("X-Admin-CSRF", reviewerCsrf)
        .send({ password: second.password })
        .expect(200);
      await post({ ...firstInput, idleSeconds: 3601 }).expect(400);
      await post({
        ...firstInput,
        idleSeconds: 1800,
        absoluteSeconds: 900,
      }).expect(400);
      await post({
        ...firstInput,
        providerUrl: "https://untrusted.example",
      }).expect(400);
      first = (await post(firstInput).expect(200)).body.id;
      stale = (await post(proposal()).expect(200)).body.id;
    },
  );
  await check(
    "policy retry receipts bind values, independent reviewers and current proposer authority",
    async () => {
      assert.equal((await post(firstInput).expect(200)).body.id, first);
      await post({ ...firstInput, maxSessions: 3 }).expect(409);
      await denied(
        platformCommand(own, "reviewSessionPolicy", {
          proposalId: first,
          action: "approve",
          requestId: randomUUID(),
        }),
      );
      await owner.query(
        "UPDATE platform_accounts SET permissions=array_append(permissions,'platform.policy.approve') WHERE admin_user_id=$1",
        [technical.id],
      );
      await denied(
        platformCommand(own, "reviewSessionPolicy", {
          proposalId: first,
          action: "approve",
          requestId: randomUUID(),
        }),
      );
      await owner.query(
        "UPDATE platform_accounts SET permissions=array_remove(permissions,'platform.policy.approve') WHERE admin_user_id=$1",
        [technical.id],
      );
      await denied(platformCommand(other, "proposeSessionPolicy", proposal()));
      const key = randomUUID();
      await review(first, "approve", key);
      await review(first, "approve", key);
      await denied(review(first, "reject", key), 409);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM audit_log WHERE event_type='PLATFORM_SESSION_POLICY_REVIEWED' AND payload::jsonb->>'proposalId'=$1",
            [first],
          )
        ).rows[0].n,
        1,
      );
      await denied(review(stale), 409);
    },
  );
  await check(
    "approved policy changes real new sessions, pins existing idle expiry and enforces concurrent login cap",
    async () => {
      const previous = (
        await owner.query(
          "SELECT policy_version,policy_idle_seconds FROM admin_sessions WHERE id=$1",
          [own.sessionId],
        )
      ).rows[0];
      assert.equal(previous.policy_version, null);
      await tech.get(base + "/auth/me").expect(200);
      assert.equal(
        (
          await owner.query(
            "SELECT round(extract(epoch FROM idle_expires_at-last_seen_at))::int idle FROM admin_sessions WHERE id=$1",
            [own.sessionId],
          )
        ).rows[0].idle,
        previous.policy_idle_seconds,
      );
      const agents = [
        request.agent(app),
        request.agent(app),
        request.agent(app),
      ];
      for (const agent of agents) {
        const response = await agent
          .post(base + "/demo/login")
          .set("Origin", origin)
          .send({ accountId: orgId })
          .expect(200);
        assert.match(response.headers["set-cookie"].join(";"), /Max-Age=1800/);
      }
      await agents[0].get(base + "/auth/me").expect(401);
      await agents[1].get(base + "/auth/me").expect(200);
      await agents[2].get(base + "/auth/me").expect(200);
      const active = (
        await owner.query(
          "SELECT policy_version,policy_idle_seconds,round(extract(epoch FROM absolute_expires_at-created_at))::int absolute FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL AND idle_expires_at>now()",
          [orgId],
        )
      ).rows;
      assert.equal(active.length, 2);
      for (const row of active) {
        assert.equal(row.policy_version, 1);
        assert.equal(row.policy_idle_seconds, 300);
        assert.equal(row.absolute, 1800);
      }
    },
  );
  await check(
    "policy audit failure and authority expiry roll back approval and runtime changes",
    async () => {
      const id = (await post(proposal(1)).expect(200)).body.id;
      const original = SecurityService.logAuditEventInTransaction;
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw Error("synthetic audit unavailable");
        };
        await assert.rejects(review(id), /synthetic audit unavailable/);
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM session_policy_proposals WHERE id=$1",
            [id],
          )
        ).rows[0].status,
        "pending",
      );
      const expiry = (
        await owner.query(
          "SELECT valid_until FROM platform_accounts WHERE admin_user_id=$1",
          [technical.id],
        )
      ).rows[0].valid_until;
      let approvalAudited = false;
      try {
        await owner.query(
          "UPDATE platform_accounts SET valid_until=clock_timestamp()+interval '3 seconds' WHERE admin_user_id=$1",
          [technical.id],
        );
        SecurityService.logAuditEventInTransaction = async (
          client,
          event,
          payload,
        ) => {
          await original.call(SecurityService, client, event, payload);
          if (event === "PLATFORM_SESSION_POLICY_REVIEWED") {
            approvalAudited = true;
            await client.query("SELECT pg_sleep(3.1)");
          }
        };
        await denied(review(id));
        assert.equal(
          approvalAudited,
          true,
          "expiry must occur after the initial approval, during audit",
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query(
          "UPDATE platform_accounts SET valid_until=$2 WHERE admin_user_id=$1",
          [technical.id, expiry],
        );
      }
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM session_policy_proposals WHERE id=$1",
            [id],
          )
        ).rows[0].status,
        "pending",
      );
      assert.equal(
        (await owner.query("SELECT ertad.current_session_policy() p")).rows[0].p
          .version,
        1,
      );
      await review(id, "reject");
      await denied(review(id), 409);
    },
  );
  await check(
    "expired or stale proposals cannot apply; withdrawal and new approved restoration preserve history",
    async () => {
      await platformCommand(own, "reviewSessionPolicy", {
        proposalId: stale,
        action: "withdraw",
        requestId: randomUUID(),
      });
      const expired = (await post(proposal(1)).expect(200)).body.id;
      await owner.query(
        "UPDATE session_policy_proposals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [expired],
      );
      await denied(review(expired), 409);
      const restored = (
        await post({
          ...proposal(1),
          idleSeconds: 900,
          absoluteSeconds: 28800,
          maxSessions: 3,
          reason: "recovery",
        }).expect(200)
      ).body.id;
      await reviewer
        .post(base + "/platform/session-policy/review")
        .set("Origin", origin)
        .set("X-Admin-CSRF", reviewerCsrf)
        .send({
          requestId: randomUUID(),
          proposalId: restored,
          action: "approve",
        })
        .expect(200);
      const response = await tech
        .get(base + "/platform/session-policy")
        .expect(200);
      assert.equal(response.body.current.version, 2);
      assert.equal(response.body.current.idleSeconds, 900);
      assert.equal(
        response.body.items.filter((item: any) => item.status === "approved")
          .length,
        2,
      );
      assert.equal(
        response.body.items.find((item: any) => item.id === expired).status,
        "expired",
      );
      assert(!JSON.stringify(response.body).includes(second.id));
      assert(!JSON.stringify(response.body).includes(technical.id));
    },
  );
  await check(
    "racing reviews create one new version and deadline expiry during audit rolls back",
    async () => {
      const input = {
        ...proposal(2),
        idleSeconds: 900,
        absoluteSeconds: 28800,
        maxSessions: 3,
      };
      const a = (await post(input).expect(200)).body.id,
        b = (await post({ ...input, requestId: randomUUID() }).expect(200)).body
          .id;
      const results = await Promise.allSettled([review(a), review(b)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const failure = results.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult;
      assert.equal(failure.reason.statusCode, 409);
      const id = (await post({ ...proposal(3), maxSessions: 3 }).expect(200))
        .body.id;
      const original = SecurityService.logAuditEventInTransaction;
      let deadlineAudited = false;
      try {
        await owner.query(
          "UPDATE session_policy_proposals SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",
          [id],
        );
        SecurityService.logAuditEventInTransaction = async (
          client,
          event,
          payload,
        ) => {
          await original.call(SecurityService, client, event, payload);
          if (event === "PLATFORM_SESSION_POLICY_REVIEWED") {
            deadlineAudited = true;
            await client.query("SELECT pg_sleep(3.1)");
          }
        };
        await denied(review(id), 409);
        assert.equal(
          deadlineAudited,
          true,
          "review deadline must expire during audit",
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM session_policy_proposals WHERE id=$1",
            [id],
          )
        ).rows[0].status,
        "pending",
      );
      assert.equal(
        (await owner.query("SELECT ertad.current_session_policy() p")).rows[0].p
          .version,
        3,
      );
    },
  );
  await check(
    "runtime cannot write policy tables directly and an installer cannot revive revoked authority",
    async () => {
      const { pool } = await import("../backend/src/db/client");
      await assert.rejects(
        pool.query("UPDATE ertad.session_policy_proposals SET max_sessions=10"),
        (e: any) => e.code === "42501",
      );
      await owner.query(
        "UPDATE platform_accounts SET revoked_at=clock_timestamp() WHERE admin_user_id=$1",
        [technical.id],
      );
      try {
        await tech.get(base + "/platform/session-policy").expect(403);
        await owner.query("BEGIN");
        assert.equal(await enablePlatformPolicy(owner, technical.id), false);
        await owner.query("COMMIT");
      } finally {
        await owner.query(
          "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
          [technical.id],
        );
      }
    },
  );
  await check(
    "password step-up remains available during concurrent technical refreshes",
    async () => {
      for (let round = 0; round < 3; round++) {
        await Promise.all([
          tech
            .post(base + "/auth/step-up")
            .set("Origin", origin)
            .set("X-Admin-CSRF", csrf)
            .send({ password: technical.password })
            .expect(200),
          tech.get(base + "/platform/access").expect(200),
          tech.get(base + "/platform/session-policy").expect(200),
          tech.get(base + "/platform/sessions").expect(200),
        ]);
      }
      const state = (
        await owner.query(
          "SELECT step_up_expires_at>clock_timestamp() valid FROM admin_sessions WHERE id=$1",
          [own.sessionId],
        )
      ).rows[0];
      assert.equal(state.valid, true);
    },
  );
  return second;
}
