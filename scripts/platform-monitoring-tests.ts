import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import type { Client } from "pg";
import { SecurityService } from "../backend/src/services/security";

export async function testPlatformMonitoring(
  app: Express,
  owner: Client,
  technical: { id: string; password: string },
  organizationId: string,
  check: (name: string, fn: () => Promise<void>) => Promise<void>,
) {
  // The preceding policy suite uses the same real per-IP API budget.
  // Preserve the limiter and start this independent journey in a fresh window.
  console.log("Monitoring tests: waiting for a fresh API rate window");
  await new Promise((resolve) => setTimeout(resolve, 60000));
  const base = "/api/v1/admin",
    path = base + "/platform/monitoring",
    origin = "http://localhost:15173";
  const tech = request.agent(app),
    org = request.agent(app);
  const login = await tech
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: technical.id })
    .expect(200);
  await org
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: organizationId })
    .expect(200);
  await check(
    "monitoring uses explicit technical audit authority and rejects unbounded queries",
    async () => {
      await request(app).get(path).expect(401);
      await org.get(path).expect(403);
      for (const query of [
        "minutes=1",
        "minutes=999999",
        "category=ip",
        "ip=192.0.2.1",
        "minutes=15&minutes=60",
      ])
        await tech.get(path + "?" + query).expect(400);
      const permissions = (
        await owner.query(
          "SELECT permissions FROM platform_accounts WHERE admin_user_id=$1",
          [technical.id],
        )
      ).rows[0].permissions;
      await owner.query(
        "UPDATE platform_accounts SET permissions=array_remove(permissions,'platform.audit.read') WHERE admin_user_id=$1",
        [technical.id],
      );
      try {
        await tech.get(path).expect(403);
      } finally {
        await owner.query(
          "UPDATE platform_accounts SET permissions=$2 WHERE admin_user_id=$1",
          [technical.id, permissions],
        );
      }
    },
  );
  await check(
    "real login and password-confirmation failures appear without identity or request data",
    async () => {
      await request(app)
        .post(base + "/auth/login")
        .set("Origin", origin)
        .send({
          email: "synthetic-private@example.invalid",
          password: "synthetic-private",
        })
        .expect(401);
      await tech
        .post(base + "/auth/step-up")
        .set("Origin", origin)
        .set("X-Admin-CSRF", login.body.csrfToken)
        .send({ password: "synthetic-private-wrong" })
        .expect(401);
      const response = await tech.get(path + "?minutes=60").expect(200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert(response.body.totals.login_failed >= 1);
      assert(response.body.totals.step_up_failed >= 1);
      assert(response.body.totals.access_denied >= 1);
      assert(response.body.items.length <= 60);
      assert(response.body.recentTechnicalEvents.length <= 5);
      assert.equal(response.body.retention, "process_memory_60_minutes");
      for (const item of response.body.items)
        assert.deepEqual(Object.keys(item).sort(), ["at", "counts"]);
      for (const item of response.body.recentTechnicalEvents)
        assert.deepEqual(Object.keys(item).sort(), ["at", "event", "id"]);
      for (const secret of [
        technical.id,
        organizationId,
        "synthetic-private",
        "token",
        "password_hash",
      ])
        assert(!JSON.stringify(response.body).includes(secret));
      const filtered = await tech
        .get(path + "?category=access_denied")
        .expect(200);
      assert.equal(filtered.body.totals.login_failed, 0);
      await tech
        .post(base + "/auth/step-up")
        .set("Origin", origin)
        .set("X-Admin-CSRF", login.body.csrfToken)
        .send({ password: technical.password })
        .expect(200);
    },
  );
  await check(
    "monitoring withholds observations on audit failure or authority loss during audit",
    async () => {
      const original = SecurityService.logAuditEventInTransaction;
      const expiry = (
        await owner.query(
          "SELECT valid_until FROM platform_accounts WHERE admin_user_id=$1",
          [technical.id],
        )
      ).rows[0].valid_until;
      let audited = false;
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw Error("synthetic audit unavailable");
        };
        const failed = await tech.get(path).expect(500);
        assert.equal(failed.body.totals, undefined);
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
          if (event === "PLATFORM_AUDIT_READ") {
            audited = true;
            await client.query("SELECT pg_sleep(3.1)");
          }
        };
        const denied = await tech.get(path).expect(403);
        assert.equal(
          audited,
          true,
          "authority must expire after the initial authorization, during audit",
        );
        assert.equal(denied.body.items, undefined);
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query(
          "UPDATE platform_accounts SET valid_until=$2 WHERE admin_user_id=$1",
          [technical.id, expiry],
        );
      }
      // The disposable fixture's expiry is restored; the failed read/audit was rolled back.
      await tech.get(path).expect(200);
      const collector = app.locals.securityTelemetry;
      try {
        delete app.locals.securityTelemetry;
        await tech.get(path).expect(500);
      } finally {
        app.locals.securityTelemetry = collector;
      }
    },
  );
}
