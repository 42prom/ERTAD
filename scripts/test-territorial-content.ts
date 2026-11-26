import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_t4_test_${randomBytes(8).toString("hex")}`;
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
const config = {
  host: "127.0.0.1",
  port,
  user: "ertad_owner",
  password: process.env.POSTGRES_PASSWORD,
};
const control = new pg.Client({ ...config, database: "ertad" });
const owner = new pg.Client({
  ...config,
  database,
  options: "-c search_path=ertad,public",
});

process.env.NODE_ENV = "test";
process.env.ERTAD_WEB_DEMO = "true";
process.env.ERTAD_ENFORCE_MOBILE_BIOMETRIC = "false";
process.env.API_KEY_ENCRYPTION_SECRET = randomBytes(32).toString("base64url");
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;

let created = false;
let connected = false;
let close: (() => Promise<void>) | undefined;
let checks = 0;

const origin = "http://localhost:15173";
const base = "/api/v1/admin";
const mobileBase = "/api/v1/mobile";

// Valid 1x1 PNG bytes for attachment upload/download verification
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

  const { createApp } = await import("../backend/src/app");
  const { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { createLocalMobileRouter } = await import("../backend/src/modules/mobile/router");
  const { encryptSensitiveValue } = await import("../backend/src/services/secretEncryption");

  const app = createApp(
    {
      postgres: async () => {},
      redis: async () => {},
      storage: async () => {},
    },
    pino({ level: "silent" }),
    origin,
    createLocalAdminRouter(origin),
    undefined,
    undefined,
    undefined,
    createLocalMobileRouter(origin),
  );

  await owner.query("BEGIN");
  const orgId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.organizations(name) VALUES ('T4 Scoped Content Org') RETURNING id`,
    )
  ).rows[0].id;
  const rootId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type)
       VALUES ($1,NULL,'National Root','authority','unclassified') RETURNING id`,
      [orgId],
    )
  ).rows[0].id;
  const tbilisiRegionId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Tbilisi Region','authority','region','GE-TB') RETURNING id`,
      [orgId, rootId],
    )
  ).rows[0].id;
  const kakhetiRegionId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Kakheti Region','authority','region','GE-KA') RETURNING id`,
      [orgId, rootId],
    )
  ).rows[0].id;
  const saburtaloId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Saburtalo Locality','authority','locality','GE-TB-SABURTALO') RETURNING id`,
      [orgId, tbilisiRegionId],
    )
  ).rows[0].id;
  const telaviId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Telavi Locality','authority','locality','GE-KA-TELAVI') RETURNING id`,
      [orgId, kakhetiRegionId],
    )
  ).rows[0].id;
  const groupAId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Saburtalo Group A','authority','group','GE-TB-SABURTALO') RETURNING id`,
      [orgId, saburtaloId],
    )
  ).rows[0].id;
  const groupBId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Saburtalo Group B','authority','group','GE-TB-SABURTALO') RETURNING id`,
      [orgId, saburtaloId],
    )
  ).rows[0].id;
  const groupKId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Telavi Group K','authority','group','GE-KA-TELAVI') RETURNING id`,
      [orgId, telaviId],
    )
  ).rows[0].id;

  const createPosition = async (
    unitId: string,
    posName: string,
    perms: Array<{ permission: string; scope: "unit" | "subtree" }>,
  ) => {
    const bundleId = randomUUID();
    await owner.query(
      `INSERT INTO ertad.permission_bundles(organization_id,id,version,status) VALUES ($1,$2,1,'draft')`,
      [orgId, bundleId],
    );
    for (const g of perms) {
      await owner.query(
        `INSERT INTO ertad.permission_grants(organization_id,bundle_id,bundle_version,permission,scope)
         VALUES ($1,$2,1,$3,$4)`,
        [orgId, bundleId, g.permission, g.scope],
      );
    }
    await owner.query(
      `UPDATE ertad.permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2 AND version=1`,
      [orgId, bundleId],
    );
    return (
      await owner.query<{ id: string }>(
        `INSERT INTO ertad.positions(organization_id,unit_id,name,bundle_id,bundle_version)
         VALUES ($1,$2,$3,$4,1) RETURNING id`,
        [orgId, unitId, posName, bundleId],
      )
    ).rows[0].id;
  };

  const posTbilisiMgr = await createPosition(tbilisiRegionId, "Tbilisi Coordinator", [
    { permission: "unit.read", scope: "subtree" },
    { permission: "member.read", scope: "subtree" },
    { permission: "channel.read", scope: "unit" },
    { permission: "channel.post", scope: "unit" },
    { permission: "channel.manage", scope: "unit" },
    { permission: "workitem.read", scope: "subtree" },
    { permission: "workitem.create", scope: "subtree" },
    { permission: "decision.read", scope: "subtree" },
    { permission: "decision.manage", scope: "subtree" },
    { permission: "decision.publish", scope: "subtree" },
    { permission: "membership.approve", scope: "subtree" },
    { permission: "membership.propose", scope: "subtree" },
  ]);
  const posGroupMember = (unitId: string, name: string) =>
    createPosition(unitId, name, [
      { permission: "unit.read", scope: "unit" },
      { permission: "channel.read", scope: "unit" },
      { permission: "channel.post", scope: "unit" },
      { permission: "workitem.read", scope: "unit" },
      { permission: "workitem.participate", scope: "unit" },
      { permission: "decision.read", scope: "unit" },
      { permission: "decision.vote", scope: "unit" },
    ]);

  const posMemberA = await posGroupMember(groupAId, "Group A Member");
  const posMemberB = await posGroupMember(groupBId, "Group B Member");
  const posMemberK = await posGroupMember(groupKId, "Group K Member");

  const posKakhetiMgr = await createPosition(kakhetiRegionId, "Kakheti Coordinator", [
    { permission: "unit.read", scope: "subtree" },
    { permission: "workitem.read", scope: "subtree" },
    { permission: "workitem.create", scope: "subtree" },
    { permission: "decision.read", scope: "subtree" },
    { permission: "decision.manage", scope: "subtree" },
    { permission: "decision.publish", scope: "subtree" },
  ]);

  const makeUser = async (email: string, fullName: string, mode: "web" | "mobile" = "web") => {
    const adminId = (
      await owner.query<{ id: string }>(
        `INSERT INTO ertad.admin_users(email,password_hash,role,full_name,is_active,mfa_enabled)
         VALUES ($1,'$2b$04$dummyhashdummyhashdummyhashdu','admin',$2,true,false) RETURNING id`,
        [email, fullName],
      )
    ).rows[0].id;
    const memberId = (
      await owner.query<{ id: string }>(
        `INSERT INTO ertad.member_users(web_account_id,status) VALUES ($1,'active') RETURNING id`,
        [adminId],
      )
    ).rows[0].id;
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const csrf = randomBytes(32).toString("base64url");
    const csrfHash = createHash("sha256").update(csrf).digest("hex");
    const csrfEncrypted = encryptSensitiveValue(csrf);
    await owner.query(
      `INSERT INTO ertad.admin_sessions(
         admin_user_id,token_hash,csrf_token_hash,csrf_token_encrypted,session_kind,step_up_expires_at,idle_expires_at,absolute_expires_at
       ) VALUES ($1,$2,$3,$4,$5,clock_timestamp() + interval '1 hour',clock_timestamp() + interval '2 hours',clock_timestamp() + interval '8 hours')`,
      [adminId, tokenHash, csrfHash, csrfEncrypted, mode],
    );
    const headers: Record<string, string> =
      mode === "mobile"
        ? { Authorization: `Bearer ${rawToken}`, "X-Mobile-Csrf": csrf }
        : {
            Cookie: `ertad_admin_session=${rawToken}`,
            Origin: origin,
            "X-Admin-Csrf": csrf,
          };
    return { adminId, memberId, headers };
  };

  const tbilisiMgr = await makeUser("tb-mgr@t4.invalid", "Tbilisi Mgr");
  const kakhetiMgr = await makeUser("ka-mgr@t4.invalid", "Kakheti Mgr");
  const memberA = await makeUser("mem-a@t4.invalid", "Member A", "mobile");
  const memberB = await makeUser("mem-b@t4.invalid", "Member B", "mobile");
  const memberK = await makeUser("mem-k@t4.invalid", "Member K", "mobile");
  const lateMemberA = await makeUser("late-a@t4.invalid", "Late Member A", "mobile");

  const grantMembership = async (userId: string, unitId: string, posId: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO ertad.memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until)
         VALUES ($1,$2,$3,$4,1,clock_timestamp() - interval '1 day',clock_timestamp() + interval '300 days') RETURNING id`,
        [orgId, userId, unitId, posId],
      )
    ).rows[0].id;

  await grantMembership(tbilisiMgr.memberId, tbilisiRegionId, posTbilisiMgr);
  await grantMembership(kakhetiMgr.memberId, kakhetiRegionId, posKakhetiMgr);
  const memberAMembershipId = await grantMembership(memberA.memberId, groupAId, posMemberA);
  await grantMembership(memberB.memberId, groupBId, posMemberB);
  await grantMembership(memberK.memberId, groupKId, posMemberK);

  // Create Main group chat on Group A (simulating T2 creation)
  const groupAMainId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.channels(organization_id,unit_id,scope_path,title,creator_id,channel_kind,is_main)
       VALUES ($1,$2,ertad.unit_path($1,$2),'Saburtalo Group A',$3,'group',true) RETURNING id`,
      [orgId, groupAId, tbilisiMgr.memberId],
    )
  ).rows[0].id;
  await owner.query("COMMIT");

  // Helper to upload an attachment via HTTP to verify attachment download isolation
  async function uploadAttachment(
    headers: Record<string, string>,
    routePrefix: string,
    channelId: string,
  ): Promise<string> {
    const res = await request(app)
      .post(`${routePrefix}/channels/attachment`)
      .query({ organizationId: orgId, id: channelId, key: randomUUID() })
      .set(headers)
      .set("Content-Type", "image/png")
      .send(TINY_PNG)
      .expect(201);
    return res.body.id;
  }

  let internalAdminChannelId = "";
  let internalAdminAttachmentId = "";
  let regionalAnnouncementId = "";
  let regionalAnnouncementAttachmentId = "";
  let groupAMainAttachmentId = "";

  await check("1. Provision regional internal chat, regional descendant announcement, and group main chat message", async () => {
    const intRes = await request(app)
      .post(`${base}/channels/create`)
      .set(tbilisiMgr.headers)
      .send({
        organizationId: orgId,
        unitId: tbilisiRegionId,
        title: "Tbilisi Admin Internal",
        key: randomUUID(),
      })
      .expect(200);
    internalAdminChannelId = intRes.body.id;

    internalAdminAttachmentId = await uploadAttachment(tbilisiMgr.headers, base, internalAdminChannelId);
    await request(app)
      .post(`${base}/channels/post`)
      .set(tbilisiMgr.headers)
      .send({
        organizationId: orgId,
        id: internalAdminChannelId,
        body: "Confidential regional budget discussion keyword-alpha",
        attachmentId: internalAdminAttachmentId,
        key: randomUUID(),
      })
      .expect(200);

    const annRes = await request(app)
      .post(`${base}/channels/create`)
      .set(tbilisiMgr.headers)
      .send({
        organizationId: orgId,
        unitId: tbilisiRegionId,
        title: "Tbilisi Regional Announcements",
        kind: "global",
        key: randomUUID(),
      })
      .expect(200);
    regionalAnnouncementId = annRes.body.id;

    regionalAnnouncementAttachmentId = await uploadAttachment(tbilisiMgr.headers, base, regionalAnnouncementId);
    await request(app)
      .post(`${base}/channels/post`)
      .set(tbilisiMgr.headers)
      .send({
        organizationId: orgId,
        id: regionalAnnouncementId,
        body: "Regional assembly Saturday 18:00 announcement-token",
        attachmentId: regionalAnnouncementAttachmentId,
        key: randomUUID(),
      })
      .expect(200);

    groupAMainAttachmentId = await uploadAttachment(memberA.headers, mobileBase, groupAMainId);
    await request(app)
      .post(`${mobileBase}/channels/post`)
      .set(memberA.headers)
      .send({
        organizationId: orgId,
        id: groupAMainId,
        body: "Hello Group A members sibling-secret-phrase",
        attachmentId: groupAMainAttachmentId,
        key: randomUUID(),
      })
      .expect(200);
  });

  await check("2. Regional internal admin chat stays isolated from descendant Group A & sibling/foreign members", async () => {
    for (const actorHeaders of [memberA.headers, memberB.headers, memberK.headers]) {
      await request(app)
        .get(`${mobileBase}/channels/thread`)
        .query({ organizationId: orgId, id: internalAdminChannelId })
        .set(actorHeaders)
        .expect(403);
      await request(app)
        .get(`${mobileBase}/channels/search`)
        .query({ organizationId: orgId, id: internalAdminChannelId, search: "keyword-alpha" })
        .set(actorHeaders)
        .expect(403);
      await request(app)
        .get(`${mobileBase}/channels/attachment/download`)
        .query({ organizationId: orgId, id: internalAdminChannelId, attachmentId: internalAdminAttachmentId })
        .set(actorHeaders)
        .expect(403);
      await request(app)
        .post(`${mobileBase}/channels/post`)
        .set(actorHeaders)
        .send({
          organizationId: orgId,
          id: internalAdminChannelId,
          body: "Unauthorized write attempt",
          key: randomUUID(),
        })
        .expect(403);
    }
  });

  await check("3. Sibling Group A main chat is isolated from same-district Group B member", async () => {
    await request(app)
      .get(`${mobileBase}/channels/thread`)
      .query({ organizationId: orgId, id: groupAMainId })
      .set(memberB.headers)
      .expect(403);
    await request(app)
      .get(`${mobileBase}/channels/search`)
      .query({ organizationId: orgId, id: groupAMainId, search: "sibling-secret-phrase" })
      .set(memberB.headers)
      .expect(403);
    await request(app)
      .get(`${mobileBase}/channels/attachment/download`)
      .query({ organizationId: orgId, id: groupAMainId, attachmentId: groupAMainAttachmentId })
      .set(memberB.headers)
      .expect(403);
    const listB = await request(app)
      .get(`${mobileBase}/channels/list`)
      .query({ organizationId: orgId, unitId: groupAId, kind: "member_all" })
      .set(memberB.headers)
      .expect(200);
    assert.ok(
      !listB.body.items.some((c: { id: string }) => c.id === groupAMainId),
      "Passing unauthorized unitId filter must never expose sibling group chat",
    );
  });

  await check("4. Descendant announcement lets Group A read/search/download/mark read, denies post & hides ancestor directory", async () => {
    const listA = await request(app)
      .get(`${mobileBase}/channels/list`)
      .query({ organizationId: orgId, unitId: groupAId, kind: "member_all" })
      .set(memberA.headers)
      .expect(200);
    const mainRow = listA.body.items.find((c: { id: string }) => c.id === groupAMainId);
    const annRow = listA.body.items.find((c: { id: string }) => c.id === regionalAnnouncementId);
    assert.ok(mainRow && annRow);
    assert.equal(mainRow.isMain, true);
    assert.equal(mainRow.audienceScope, "unit_only");
    assert.equal(annRow.audienceScope, "unit_and_descendants");
    assert.equal(annRow.canPost, false, "Descendant member cannot post to regional announcement");
    assert.ok(
      !listA.body.items.some((c: { id: string }) => c.id === internalAdminChannelId),
      "Regional internal admin chat must not appear in descendant member list",
    );

    const th = await request(app)
      .get(`${mobileBase}/channels/thread`)
      .query({ organizationId: orgId, id: regionalAnnouncementId })
      .set(memberA.headers)
      .expect(200);
    assert.equal(th.body.items.length, 1);
    assert.equal(th.body.channel.canPost, false);

    const srch = await request(app)
      .get(`${mobileBase}/channels/search`)
      .query({ organizationId: orgId, id: regionalAnnouncementId, search: "announcement-token" })
      .set(memberA.headers)
      .expect(200);
    assert.equal(srch.body.items.length, 1);

    const dl = await request(app)
      .get(`${mobileBase}/channels/attachment/download`)
      .query({
        organizationId: orgId,
        id: regionalAnnouncementId,
        attachmentId: regionalAnnouncementAttachmentId,
      })
      .set(memberA.headers)
      .expect(200);
    assert.ok(
      Buffer.isBuffer(dl.body) &&
        dl.body.length > 8 &&
        dl.body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    );

    // Mark announcement read -> clears unread count
    await request(app)
      .post(`${mobileBase}/channels/read`)
      .set(memberA.headers)
      .send({
        organizationId: orgId,
        id: regionalAnnouncementId,
        seq: th.body.items[0].seq,
        key: randomUUID(),
      })
      .expect(200);

    const listAfterRead = await request(app)
      .get(`${mobileBase}/channels/list`)
      .query({ organizationId: orgId, unitId: groupAId, view: "unread" })
      .set(memberA.headers)
      .expect(200);
    assert.ok(
      !listAfterRead.body.items.some((c: { id: string }) => c.id === regionalAnnouncementId),
      "Unread announcement must clear after read receipt",
    );

    // Writing to regional announcement must fail closed (403) even with group channel.post
    await request(app)
      .post(`${mobileBase}/channels/post`)
      .set(memberA.headers)
      .send({
        organizationId: orgId,
        id: regionalAnnouncementId,
        body: "Member A attempting to post in regional announcement",
        key: randomUUID(),
      })
      .expect(403);

    // Viewing participants on ancestor announcement must not disclose ancestor directory
    const parts = await request(app)
      .get(`${mobileBase}/channels/participants`)
      .query({ organizationId: orgId, id: regionalAnnouncementId })
      .set(memberA.headers)
      .expect(200);
    assert.deepEqual(parts.body.items, []);

    // Another region member (Kakheti) gets 403 across all announcement endpoints
    await request(app)
      .get(`${mobileBase}/channels/thread`)
      .query({ organizationId: orgId, id: regionalAnnouncementId })
      .set(memberK.headers)
      .expect(403);
    await request(app)
      .get(`${mobileBase}/channels/search`)
      .query({ organizationId: orgId, id: regionalAnnouncementId, search: "announcement-token" })
      .set(memberK.headers)
      .expect(403);
    await request(app)
      .get(`${mobileBase}/channels/attachment/download`)
      .query({
        organizationId: orgId,
        id: regionalAnnouncementId,
        attachmentId: regionalAnnouncementAttachmentId,
      })
      .set(memberK.headers)
      .expect(403);
  });

  await check("5. Group-filtered Tasks, Events & Decisions preserve boundaries and frozen electorate", async () => {
    const deadline = new Date(Date.now() + 5 * 86400_000).toISOString();
    const startsAt = new Date(Date.now() + 2 * 86400_000).toISOString();
    const endsAt = new Date(Date.now() + 2 * 86400_000 + 3 * 3600_000).toISOString();

    const taskARes = await request(app)
      .post(`${base}/work/create`)
      .set(tbilisiMgr.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        title: "Group A Task",
        description: "Scoped group task",
        roleLabel: "Helper",
        priority: "normal",
        capacity: 5,
        deadline,
        key: randomUUID(),
      })
      .expect(200);

    await request(app)
      .post(`${base}/work/create`)
      .set(kakhetiMgr.headers)
      .send({
        organizationId: orgId,
        unitId: groupKId,
        title: "Group K Task",
        description: "Other region task",
        roleLabel: "Helper",
        priority: "normal",
        capacity: 5,
        deadline,
        key: randomUUID(),
      })
      .expect(200);

    const evARes = await request(app)
      .post(`${base}/work/event_create`)
      .set(tbilisiMgr.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        title: "Group A Event",
        description: "Scoped group event",
        location: "Saburtalo Hall",
        startsAt,
        endsAt,
        contributionRuleId: null,
        key: randomUUID(),
      })
      .expect(200);

    await request(app)
      .post(`${base}/work/event_create`)
      .set(kakhetiMgr.headers)
      .send({
        organizationId: orgId,
        unitId: groupKId,
        title: "Group K Event",
        description: "Other region event",
        location: "Telavi Hall",
        startsAt,
        endsAt,
        contributionRuleId: null,
        key: randomUUID(),
      })
      .expect(200);

    // Publish a named Decision on Group A before lateMemberA is admitted
    const decRes = await request(app)
      .post(`${base}/decisions/create`)
      .set(tbilisiMgr.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        title: "Group A Decision",
        description: "Decision created before late member joins",
        kind: "poll",
        privacy: "named",
        quorum: 1,
        includedUnitIds: [groupAId],
        excludedUnitIds: [],
        options: ["Approve option", "Reject option"],
        closesAt: new Date(Date.now() + 4 * 86400_000).toISOString(),
        key: randomUUID(),
      })
      .expect(200);
    await request(app)
      .post(`${base}/decisions/publish`)
      .set(tbilisiMgr.headers)
      .send({
        organizationId: orgId,
        id: decRes.body.id,
        version: 1,
        key: randomUUID(),
      })
      .expect(200);

    // Admitting lateMemberA AFTER decision publish does NOT enter the frozen electorate
    await owner.query(
      `INSERT INTO ertad.memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until)
       VALUES ($1,$2,$3,$4,1,clock_timestamp(),clock_timestamp() + interval '100 days')`,
      [orgId, lateMemberA.memberId, groupAId, posMemberA],
    );

    const wA = await request(app)
      .get(`${mobileBase}/work/list`)
      .query({ organizationId: orgId, unitId: groupAId })
      .set(memberA.headers)
      .expect(200);
    assert.equal(wA.body.items.length, 1);
    assert.equal(wA.body.items[0].id, taskARes.body.id);

    const evA = await request(app)
      .get(`${mobileBase}/work/event_list`)
      .query({ organizationId: orgId, unitId: groupAId })
      .set(memberA.headers)
      .expect(200);
    assert.equal(evA.body.items.length, 1);
    assert.equal(evA.body.items[0].id, evARes.body.id);

    const decListA = await request(app)
      .get(`${mobileBase}/decisions/list`)
      .query({ organizationId: orgId, unitId: groupAId, view: "open" })
      .set(memberA.headers)
      .expect(200);
    assert.equal(decListA.body.items.length, 1);
    assert.equal(decListA.body.items[0].id, decRes.body.id);

    // Passing another unitId filter never expands access for unauthorized user
    await request(app)
      .get(`${mobileBase}/work/list`)
      .query({ organizationId: orgId, unitId: groupBId })
      .set(memberA.headers)
      .expect(403);

    const evWrongUnit = await request(app)
      .get(`${mobileBase}/work/event_list`)
      .query({ organizationId: orgId, unitId: groupBId })
      .set(memberA.headers)
      .expect(200);
    assert.equal(evWrongUnit.body.items.length, 0);

    const decWrongUnit = await request(app)
      .get(`${mobileBase}/decisions/list`)
      .query({ organizationId: orgId, unitId: groupBId, view: "open" })
      .set(memberA.headers)
      .expect(200);
    assert.equal(decWrongUnit.body.items.length, 0);

    // Frozen electorate check: lateMemberA cannot vote on the pre-existing decision
    await request(app)
      .post(`${mobileBase}/decisions/vote`)
      .set(lateMemberA.headers)
      .send({
        organizationId: orgId,
        id: decRes.body.id,
        choice: 0,
        key: randomUUID(),
      })
      .expect(403);
  });

  await check("6. Membership revocation immediately blocks chat, announcement, search & attachment access", async () => {
    await owner.query(
      `UPDATE ertad.memberships SET status = 'ended' WHERE organization_id = $1 AND id = $2`,
      [orgId, memberAMembershipId],
    );

    for (const [channelId, attachmentId] of [
      [groupAMainId, groupAMainAttachmentId],
      [regionalAnnouncementId, regionalAnnouncementAttachmentId],
    ]) {
      await request(app)
        .get(`${mobileBase}/channels/thread`)
        .query({ organizationId: orgId, id: channelId })
        .set(memberA.headers)
        .expect(403);
      await request(app)
        .get(`${mobileBase}/channels/search`)
        .query({ organizationId: orgId, id: channelId, search: "Group" })
        .set(memberA.headers)
        .expect(403);
      await request(app)
        .get(`${mobileBase}/channels/attachment/download`)
        .query({ organizationId: orgId, id: channelId, attachmentId })
        .set(memberA.headers)
        .expect(403);
    }
  });

  console.log(`ALL PASSED: ${checks} territorial scoped content checks`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) {
    await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  }
  await control.end();
}
