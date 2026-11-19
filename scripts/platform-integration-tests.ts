import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import type { Client } from "pg";
import { enablePlatformIntegrations } from "./platform-fixture";
import { SecurityService } from "../backend/src/services/security";

export async function testPlatformIntegrations(
  app: Express,
  owner: Client,
  technical: { id: string },
  organizationId: string,
  check: (name: string, fn: () => Promise<void>) => Promise<void>,
) {
  const base = "/api/v1/admin",
    origin = "http://localhost:15173",
    tech = request.agent(app),
    org = request.agent(app);
  const login = await tech
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: technical.id })
    .expect(200);
  const csrf = login.body.csrfToken;
  await org
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: organizationId })
    .expect(200);
  const post = (body: unknown) =>
    tech
      .post(base + "/platform/integrations/check")
      .set("Origin", origin)
      .set("X-Admin-CSRF", csrf)
      .send(body);
  const saved = app.locals.dependencyChecks;
  let probes = 0;
  app.locals.dependencyChecks = {
    postgres: async () => {
      probes++;
    },
    redis: async () => {
      probes++;
      throw Error("private endpoint secret");
    },
    storage: async () => {
      probes++;
    },
  };
  try {
    await check(
      "integration grants and diagnostic scope never derive from role or organization rank",
      async () => {
        await tech.get(base + "/platform/integrations").expect(403);
        await post({ target: "postgres" }).expect(403);
        assert.equal(probes, 0);
        const before = (
          await owner.query(
            "SELECT valid_until,revoked_at FROM platform_accounts WHERE admin_user_id=$1",
            [technical.id],
          )
        ).rows[0];
        await owner.query("BEGIN");
        await enablePlatformIntegrations(owner, technical.id);
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
          await enablePlatformIntegrations(owner, technical.id),
          false,
        );
        await owner.query("COMMIT");
        await org.get(base + "/platform/integrations").expect(403);
        await request(app)
          .get(base + "/platform/integrations")
          .set("Authorization", "Bearer mobile-credential")
          .expect(401);
        const response = await tech
          .get(base + "/platform/integrations")
          .expect("Cache-Control", "no-store")
          .expect(200);
        assert.equal(response.body.items.length, 11);
        assert.equal(probes, 0);
        assert.ok(
          response.body.items
            .filter((i: any) => i.category !== "infrastructure")
            .every((i: any) => !i.active && i.assurance === "not_verified"),
        );
        const serialized = JSON.stringify(response.body);
        for (const forbidden of [
          "apiKey",
          "password",
          "endpoint",
          "token_hash",
          technical.id,
          organizationId,
        ])
          assert.ok(!serialized.includes(forbidden));
      },
    );
    await check(
      "fixed diagnostics reject arbitrary destinations, extra input and CSRF/Origin failures",
      async () => {
        await post({
          target: "postgres",
          url: "http://169.254.169.254",
        }).expect(400);
        await post({ target: "liveness" }).expect(400);
        await tech
          .post(base + "/platform/integrations/check")
          .set("Origin", origin)
          .send({ target: "postgres" })
          .expect(403);
        await tech
          .post(base + "/platform/integrations/check")
          .set("Origin", "https://foreign.invalid")
          .set("X-Admin-CSRF", csrf)
          .send({ target: "postgres" })
          .expect(403);
        assert.equal(probes, 0);
        await owner.query(
          "UPDATE platform_accounts SET permissions=array_remove(permissions,'platform.integrations.test') WHERE admin_user_id=$1",
          [technical.id],
        );
        await post({ target: "postgres" }).expect(403);
        assert.equal(probes, 0);
        await owner.query("BEGIN");
        await enablePlatformIntegrations(owner, technical.id);
        await owner.query("COMMIT");
        const success = await post({ target: "postgres" }).expect(200);
        assert.equal(success.body.status, "ready");
        const failure = await post({ target: "redis" }).expect(200);
        assert.equal(failure.body.status, "unavailable");
        assert.ok(!JSON.stringify(failure.body).includes("secret"));
        assert.equal(probes, 2);
      },
    );
    await check(
      "required audit prevents probes and revoked authority during a probe withholds results",
      async () => {
        const original = SecurityService.logAuditEventInTransaction;
        try {
          SecurityService.logAuditEventInTransaction = async () => {
            throw Error("synthetic audit failure");
          };
          await post({ target: "storage" }).expect(500);
          assert.equal(probes, 2);
        } finally {
          SecurityService.logAuditEventInTransaction = original;
        }
        app.locals.dependencyChecks.storage = async () => {
          await owner.query(
            "UPDATE platform_accounts SET revoked_at=now() WHERE admin_user_id=$1",
            [technical.id],
          );
        };
        try {
          await post({ target: "storage" }).expect(403);
          await owner.query("BEGIN");
          assert.equal(
            await enablePlatformIntegrations(owner, technical.id),
            false,
          );
          await owner.query("COMMIT");
        } finally {
          await owner.query(
            "UPDATE platform_accounts SET revoked_at=NULL WHERE admin_user_id=$1",
            [technical.id],
          );
        }
        const events = (
          await owner.query(
            "SELECT payload::jsonb data FROM audit_log WHERE event_type='PLATFORM_INTEGRATION_CHECK' AND payload::jsonb->>'adminUserId'=$1",
            [technical.id],
          )
        ).rows;
        assert.ok(events.some((r) => r.data.status === "ready"));
        assert.ok(events.some((r) => r.data.status === "unavailable"));
        assert.ok(
          events.every(
            (r) =>
              Object.keys(r.data).sort().join(",") ===
              "adminUserId,operation,status,target",
          ),
        );
      },
    );
  } finally {
    app.locals.dependencyChecks = saved;
  }
}
