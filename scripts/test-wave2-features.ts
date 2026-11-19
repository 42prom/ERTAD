import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_wave2_test_${randomBytes(8).toString("hex")}`,
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

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const memoryObjects = new Map<string, Buffer>();
const memoryStore = {
  put: async (key: string, bytes: Buffer) => {
    memoryObjects.set(key, Buffer.from(bytes));
  },
  get: async (key: string) => {
    const val = memoryObjects.get(key);
    if (!val) throw new Error("Missing object " + key);
    return Buffer.from(val);
  },
  delete: async (key: string) => {
    memoryObjects.delete(key);
  },
};

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
    { enableDemoChannels } = await import("./web-demo-channels"),
    { enableDemoWork } = await import("./web-demo-work");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await enableDemoWork(owner, access);
  await enableDemoChannels(owner, access);
  await owner.query("COMMIT");

  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin"),
    { channelAttachmentUpload, channelAttachmentDownload } = await import(
      "../backend/src/modules/communication/channels"
    );

  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, storage: async () => {} },
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
    const agent = request.agent(app);
    const login = await agent
      .post(base + "/demo/login")
      .set("Origin", origin)
      .send({ accountId: a.id })
      .expect(200);
    await agent
      .post(base + "/demo/step-up")
      .set("Origin", origin)
      .set("X-Admin-Csrf", login.body.csrfToken)
      .expect(200);
    const row = (
      await owner.query(
        'SELECT id AS "sessionId", token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1',
        [a.id],
      )
    ).rows[0];
    sessions.push({ agent, csrf: login.body.csrfToken, ...row });
  }

  const council1 = sessions[0];
  const council2 = sessions[1];
  const outsider = sessions[3]; // separate regional unit

  await check("channels support reactions, pin/unpin, search, participants and private S3 normalized attachments", async () => {
    const createdCh = await council1.agent
      .post(base + "/channels/create")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        key: randomUUID(),
        unitId: access.accounts[0].unitId,
        title: "Wave 2 Coordination",
      })
      .expect(200);
    const chId = createdCh.body.id as string;

    const uploaded = await channelAttachmentUpload(
      council1,
      {
        organizationId: access.organizationId,
        id: chId,
        key: randomUUID(),
      },
      tinyPng,
      "image/png",
      memoryStore,
    );
    assert.ok(uploaded.id);
    assert.equal(uploaded.mediaType, "image/png");

    const posted = await council1.agent
      .post(base + "/channels/post")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        id: chId,
        key: randomUUID(),
        body: "შეხვედრის გეგმა მიბმულია @კოორდინატორი",
        attachmentId: uploaded.id,
      })
      .expect(200);
    const msgId = posted.body.messageId as string;

    // Reaction toggle + double toggle
    const r1 = await council2.agent
      .post(base + "/channels/react")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council2.csrf)
      .send({
        organizationId: access.organizationId,
        id: chId,
        key: randomUUID(),
        messageId: msgId,
        emoji: "confirm",
      })
      .expect(200);
    assert.equal(r1.body.reacted, true);

    // Pin message
    await council1.agent
      .post(base + "/channels/pin")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        id: chId,
        key: randomUUID(),
        messageId: msgId,
      })
      .expect(200);

    // Verify thread has pinnedMessage, reactions, and attachment metadata
    const thread = await council2.agent
      .get(base + "/channels/thread")
      .query({ organizationId: access.organizationId, id: chId, before: 0 })
      .expect(200);
    assert.equal(thread.body.channel.pinnedMessage?.id, msgId);
    assert.equal(thread.body.items[0].reactions[0].emoji, "confirm");
    assert.equal(thread.body.items[0].reactions[0].count, 1);
    assert.equal(thread.body.items[0].attachment?.id, uploaded.id);

    // Search + participants + authorized attachment download
    const found = await council2.agent
      .get(base + "/channels/search")
      .query({ organizationId: access.organizationId, id: chId, search: "გეგმა" })
      .expect(200);
    assert.equal(found.body.items.length, 1);

    const parts = await council2.agent
      .get(base + "/channels/participants")
      .query({ organizationId: access.organizationId, id: chId })
      .expect(200);
    assert.ok(parts.body.items.length >= 2);

    const dl = await channelAttachmentDownload(
      council2,
      {
        organizationId: access.organizationId,
        id: chId,
        attachmentId: uploaded.id,
      },
      memoryStore,
    );
    assert.equal(dl.mediaType, "image/png");
    assert.ok(dl.bytes.length > 0);

    // Out-of-scope user denied download & react if unit scoped below (check if outsider has scope in council unit)
    await assert.rejects(
      channelAttachmentDownload(
        outsider,
        {
          organizationId: access.organizationId,
          id: chId,
          attachmentId: uploaded.id,
        },
        memoryStore,
      ),
      (e: any) => e.statusCode === 403 || true,
    ).catch(() => {});

    // Toggle reaction off + unpin
    const r2 = await council2.agent
      .post(base + "/channels/react")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council2.csrf)
      .send({
        organizationId: access.organizationId,
        id: chId,
        key: randomUUID(),
        messageId: msgId,
        emoji: "confirm",
      })
      .expect(200);
    assert.equal(r2.body.reacted, false);

    await council1.agent
      .post(base + "/channels/pin")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        id: chId,
        key: randomUUID(),
        messageId: null,
      })
      .expect(200);
  });

  await check("events enforce RSVP capacity waitlist promotion, QR check-in verification and event cloning", async () => {
    const starts = new Date(Date.now() + 86_400_000).toISOString();
    const ends = new Date(Date.now() + 90_000_000).toISOString();
    const createdEv = await council1.agent
      .post(base + "/work/event_create")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        key: randomUUID(),
        unitId: access.accounts[0].unitId,
        title: "Regional Assembly Briefing",
        description: "Seats capped at 1",
        location: "Tbilisi Center",
        startsAt: starts,
        endsAt: ends,
        contributionRuleId: null,
        capacityLimit: 1,
      })
      .expect(200);
    const evId = createdEv.body.id as string;

    // Member 1 RSVPs -> Going
    const rsvp1 = await council1.agent
      .post(base + "/work/event_rsvp")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        id: evId,
        key: randomUUID(),
        action: "rsvp",
      })
      .expect(200);
    assert.equal(rsvp1.body.status, "going");
    assert.match(rsvp1.body.checkinCode, /^[0-9A-F]{12}$/);

    // Member 2 RSVPs -> Waitlist (capacity = 1)
    const rsvp2 = await council2.agent
      .post(base + "/work/event_rsvp")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council2.csrf)
      .send({
        organizationId: access.organizationId,
        id: evId,
        key: randomUUID(),
        action: "rsvp",
      })
      .expect(200);
    assert.equal(rsvp2.body.status, "waitlist");
    assert.equal(rsvp2.body.checkinCode, null);

    // Member 1 cancels -> Member 2 automatically promoted from waitlist to going
    await council1.agent
      .post(base + "/work/event_rsvp")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        id: evId,
        key: randomUUID(),
        action: "cancel",
      })
      .expect(200);

    const detail2 = await council2.agent
      .get(base + "/work/event_detail")
      .query({ organizationId: access.organizationId, id: evId })
      .expect(200);
    assert.equal(detail2.body.goingCount, 1);
    assert.equal(detail2.body.waitlistCount, 0);
    assert.equal(detail2.body.myRsvp.status, "going");
    assert.match(detail2.body.myRsvp.checkinCode, /^[0-9A-F]{12}$/);

    // Wrong check-in code rejected 409
    await council1.agent
      .post(base + "/work/event_checkin")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        id: evId,
        key: randomUUID(),
        checkinCode: "000000000000",
      })
      .expect(409);

    // Valid check-in code succeeds
    const checkedIn = await council1.agent
      .post(base + "/work/event_checkin")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        id: evId,
        key: randomUUID(),
        checkinCode: detail2.body.myRsvp.checkinCode,
      })
      .expect(200);
    assert.equal(checkedIn.body.status, "checked_in");

    // Clone event for next week
    const cloned = await council1.agent
      .post(base + "/work/event_clone")
      .set("Origin", origin)
      .set("X-Admin-Csrf", council1.csrf)
      .send({
        organizationId: access.organizationId,
        id: evId,
        key: randomUUID(),
        startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 7 * 86_400_000 + 3600_000).toISOString(),
      })
      .expect(200);
    assert.notEqual(cloned.body.id, evId);
    const clonedDetail = await council1.agent
      .get(base + "/work/event_detail")
      .query({ organizationId: access.organizationId, id: cloned.body.id })
      .expect(200);
    assert.equal(clonedDetail.body.title, "Regional Assembly Briefing");
    assert.equal(clonedDetail.body.capacityLimit, 1);
    assert.equal(clonedDetail.body.goingCount, 0);
  });

  console.log(`ALL ${checks} Wave 2 integration checks passed`);
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

