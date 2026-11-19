import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_workspace_test_${randomBytes(8).toString("hex")}`,
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
  base = "/api/v1/admin";

async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log(`PASS ${name}`);
}

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
        MIGRATION_DATABASE_URL: `postgresql://ertad_owner:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:${port}/${database}`,
      },
    },
  );
  await owner.connect();
  connected = true;
  const db = await import("../backend/src/db/client");
  close = db.close;
  const { seedWebDemo } = await import("./web-demo-fixture"),
    { enableDemoWork } = await import("./web-demo-work"),
    { seedPlatformOperator } = await import("./platform-fixture");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await enableDemoWork(owner, access);
  const technical = await seedPlatformOperator(owner);
  await owner.query("COMMIT");

  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, storage: async () => {} },
    pino({ level: "silent" }),
    origin,
    createLocalAdminRouter(
      origin,
      () => access,
      () => technical,
    ),
  );

  const member = request.agent(app),
    tech = request.agent(app),
    anon = request.agent(app);

  await check("unauthenticated bootstrap and realtime stream are denied", async () => {
    await anon.get(base + "/workspace/bootstrap").expect(401);
    await anon.get(base + "/stream").expect(401);
  });

  await member
    .post(base + "/demo/login")
    .set("Origin", origin)
    .send({ accountId: access.accounts[0].id })
    .expect(200);
  await tech
    .post(base + "/auth/login")
    .set("Origin", origin)
    .send({ email: technical.email, password: technical.password })
    .expect(200);

  await check("technical operator bootstrap returns empty org contexts without error", async () => {
    const res = await tech
      .get(base + "/workspace/bootstrap")
      .expect("Cache-Control", "no-store")
      .expect(200);
    assert.equal(res.body.platformAccess.technicalAccount, true);
    assert.deepEqual(res.body.units, []);
    assert.deepEqual(res.body.work, []);
    assert.equal(res.body.reviewCount, null);
    assert.equal(res.body.inbox.unread, 0);
  });

  await check("member bootstrap matches individual contexts, review count and summary KPIs in 1 call", async () => {
    const [bootstrapRes, reviewsRes, inboxRes, workRes, unitsRes] =
      await Promise.all([
        member
          .get(base + "/workspace/bootstrap")
          .expect("Cache-Control", "no-store")
          .expect(200),
        member.get(base + "/reviews/contexts").expect(200),
        member.get(base + "/inbox/summary").expect(200),
        member.get(base + "/work/contexts").expect(200),
        member.get(base + "/units/contexts").expect(200),
      ]);
    const b = bootstrapRes.body;
    assert.equal(b.platformAccess.technicalAccount, false);
    assert.deepEqual(b.reviews, reviewsRes.body);
    assert.deepEqual(b.inbox, inboxRes.body);
    assert.deepEqual(b.work, workRes.body);
    assert.deepEqual(b.units, unitsRes.body);
    assert.equal(b.summary.schedule.length, 7);
    assert.ok(Array.isArray(b.summary.urgent));
    assert.equal(typeof b.summary.openWork, "number");
    assert.equal(typeof b.summary.openDecisions, "number");

    const meRes = await member.get(base + "/auth/me").expect(200);
    await member
      .post(base + "/demo/step-up")
      .set("Origin", origin)
      .set("X-Admin-Csrf", meRes.body.csrfToken)
      .expect(200);
    const createdWork = await member
      .post(base + "/work/create")
      .set("Origin", origin)
      .set("X-Admin-Csrf", meRes.body.csrfToken)
      .send({
        organizationId: access.organizationId,
        key: randomUUID(),
        unitId: access.accounts[0].unitId,
        title: "Bootstrap Urgent Task",
        description: "Verify KPI increment",
        roleLabel: "Coordinator",
        priority: "urgent",
        capacity: 1,
        deadline: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(200);
    assert.ok(createdWork.body.id);

    const afterRes = await member.get(base + "/workspace/bootstrap").expect(200);
    assert.ok(afterRes.body.summary.openWork >= b.summary.openWork + 1);
    assert.ok(
      afterRes.body.summary.urgent.some(
        (item: { title: string; kind: string }) =>
          item.kind === "task" && item.title === "Bootstrap Urgent Task",
      ),
    );
  });

  await check("SSE /stream rejects untrusted origin and delivers sanitized domain invalidation on mutation", async () => {
    await member
      .get(base + "/stream")
      .set("Origin", "https://evil.example")
      .expect(403);

    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const { port: listenPort } = server.address() as AddressInfo;
      const loginRes = await fetch(
        `http://127.0.0.1:${listenPort}${base}/demo/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({ accountId: access.accounts[0].id }),
        },
      );
      assert.equal(loginRes.status, 200);
      const setCookie = loginRes.headers.get("set-cookie");
      assert.ok(setCookie);
      const cookieHeader = setCookie.split(";")[0];

      const controller = new AbortController();
      const streamRes = await fetch(
        `http://127.0.0.1:${listenPort}${base}/stream`,
        {
          headers: { Cookie: cookieHeader, Origin: origin },
          signal: controller.signal,
        },
      );
      assert.equal(streamRes.status, 200);
      assert.match(streamRes.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.ok(streamRes.body);
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readUntil = async (marker: string, timeoutMs = 4000) => {
        const started = Date.now();
        while (!buffer.includes(marker)) {
          if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${marker}. Buffer: ${buffer}`);
          }
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
        }
      };

      await readUntil("event: ready");

      const meRes = await fetch(`http://127.0.0.1:${listenPort}${base}/auth/me`, {
        headers: { Cookie: cookieHeader },
      });
      const meJson = (await meRes.json()) as { csrfToken: string };
      await fetch(`http://127.0.0.1:${listenPort}${base}/demo/step-up`, {
        method: "POST",
        headers: { Cookie: cookieHeader, Origin: origin, "X-Admin-Csrf": meJson.csrfToken },
      });
      const postWork = await fetch(
        `http://127.0.0.1:${listenPort}${base}/work/create`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader,
            Origin: origin,
            "X-Admin-Csrf": meJson.csrfToken,
          },
          body: JSON.stringify({
            organizationId: access.organizationId,
            key: randomUUID(),
            unitId: access.accounts[0].unitId,
            title: "Secret Private Task Title That Must Never Appear In SSE",
            description: "Should not leak in stream",
            roleLabel: "Coordinator",
            priority: "normal",
            capacity: 1,
            deadline: new Date(Date.now() + 7200_000).toISOString(),
          }),
        },
      );
      assert.equal(postWork.status, 200);

      await readUntil("event: invalidate");
      assert.match(buffer, /"topic":"work"/);
      assert.equal(buffer.includes("Secret Private Task Title"), false);
      controller.abort();
      await reader.cancel().catch(() => {});
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  console.log(`ALL ${checks} workspace and realtime integration checks passed`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) {
    await control
      .query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [database],
      )
      .catch(() => {});
    await control.query(`DROP DATABASE IF EXISTS ${database}`);
  }
  await control.end();
}

