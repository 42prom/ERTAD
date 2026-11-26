import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");

const database = `ertad_territory_e2e_${randomBytes(8).toString("hex")}`;
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
const pgConfig = {
  host: "127.0.0.1",
  port,
  user: "ertad_owner",
  password: process.env.POSTGRES_PASSWORD,
};
const control = new pg.Client({ ...pgConfig, database: "ertad" });
const owner = new pg.Client({
  ...pgConfig,
  database,
  options: "-c search_path=ertad,public",
});

process.env.NODE_ENV = "test";
process.env.ERTAD_WEB_DEMO = "true";
process.env.ERTAD_ENFORCE_MOBILE_BIOMETRIC = "false";
process.env.API_KEY_ENCRYPTION_SECRET ??= randomBytes(32).toString("base64url");
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;

const origin = "http://localhost:15173";
const ADMIN_BASE = "/api/v1/admin";
const MOBILE_BASE = "/api/v1/mobile";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const futureIso = (hours = 24) =>
  new Date(Date.now() + hours * 3600_000).toISOString();

interface ActorSession {
  adminId: string;
  memberId: string;
  rawToken: string;
  csrf: string;
  sessionKind: "web" | "mobile";
}

let created = false;
let connected = false;
let closeDb: (() => Promise<void>) | undefined;
let passed = 0;

async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
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
  closeDb = db.close;

  const { createApp } = await import("../backend/src/app");
  const { createLocalAdminRouter } = await import("../backend/src/localAdmin");
  const { createLocalMobileRouter } =
    await import("../backend/src/modules/mobile/router");
  const { hashAdminPassword } =
    await import("../backend/src/services/adminPassword");
  const { generateMfaSecret } =
    await import("../backend/src/services/adminMfa");
  const { encryptSensitiveValue } =
    await import("../backend/src/services/secretEncryption");

  const app = createApp(
    {
      postgres: async () => {},
      redis: async () => {},
      storage: async () => {},
    },
    pino({ level: "silent" }),
    origin,
    createLocalAdminRouter(origin, () => null),
    undefined,
    undefined,
    undefined,
    createLocalMobileRouter(origin, () => null),
  );

  const reqAdmin = (actor: ActorSession, method: "get" | "post", path: string) =>
    request(app)
      [method](`${ADMIN_BASE}${path}`)
      .set("Origin", origin)
      .set("Cookie", `ertad_admin_session=${actor.rawToken}`)
      .set("X-Admin-Csrf", actor.csrf);

  const reqMobile = (
    actor: ActorSession,
    method: "get" | "post",
    path: string,
  ) =>
    request(app)
      [method](`${MOBILE_BASE}${path}`)
      .set("Authorization", `Bearer ${actor.rawToken}`)
      .set("X-Mobile-Csrf", actor.csrf);

  async function createActor(
    emailPrefix: string,
    fullName: string,
    role: "superadmin" | "admin" | "observer",
    sessionKind: "web" | "mobile",
  ): Promise<ActorSession> {
    const adminId = randomUUID();
    const memberId = randomUUID();
    const rawToken = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const email = `${emailPrefix}.${randomUUID().slice(0, 6)}@example.invalid`;
    const passwordHash = await hashAdminPassword(randomBytes(24).toString("base64url"));
    const mfaEncrypted = encryptSensitiveValue(generateMfaSecret());

    await owner.query(
      `INSERT INTO admin_users(id, email, password_hash, role, full_name, mfa_secret_encrypted)
       VALUES($1, $2, $3, $4, $5, $6)`,
      [adminId, email, passwordHash, role, fullName, mfaEncrypted],
    );
    await owner.query(
      `INSERT INTO member_users(id, web_account_id) VALUES($1, $2)`,
      [memberId, adminId],
    );
    await owner.query(
      `INSERT INTO admin_sessions(
         admin_user_id, token_hash, csrf_token_hash, csrf_token_encrypted,
         idle_expires_at, absolute_expires_at, step_up_expires_at, session_kind
       ) VALUES($1, $2, $3, $4, now() + interval '1 hour', now() + interval '4 hours', now() + interval '1 hour', $5)`,
      [
        adminId,
        sha256Hex(rawToken),
        sha256Hex(csrf),
        encryptSensitiveValue(csrf),
        sessionKind,
      ],
    );
    return { adminId, memberId, rawToken, csrf, sessionKind };
  }

  async function createApprovedBundle(
    orgId: string,
    permissions: string[],
    scope: "unit" | "subtree",
  ): Promise<string> {
    const bundleId = randomUUID();
    await owner.query(
      `INSERT INTO permission_bundles(organization_id, id, version) VALUES($1, $2, 1)`,
      [orgId, bundleId],
    );
    for (const permission of permissions) {
      await owner.query(
        `INSERT INTO permission_grants VALUES($1, $2, 1, $3, $4)`,
        [orgId, bundleId, permission, scope],
      );
    }
    await owner.query(
      `UPDATE permission_bundles SET status = 'approved' WHERE organization_id = $1 AND id = $2`,
      [orgId, bundleId],
    );
    return bundleId;
  }

  async function createPositionAndAssign(
    orgId: string,
    unitId: string,
    name: string,
    bundleId: string,
    memberIds: string[] = [],
  ): Promise<{ positionId: string; membershipIds: string[] }> {
    const positionId = randomUUID();
    await owner.query(
      `INSERT INTO positions(organization_id, id, unit_id, name, bundle_id, bundle_version)
       VALUES($1, $2, $3, $4, $5, 1)`,
      [orgId, positionId, unitId, name, bundleId],
    );
    const membershipIds: string[] = [];
    for (const memberId of memberIds) {
      const m = await owner.query(
        `INSERT INTO memberships(organization_id, user_id, unit_id, position_id, bundle_version, valid_from, valid_until)
         VALUES($1, $2, $3, $4, 1, now() - interval '1 minute', now() + interval '60 days')
         RETURNING id`,
        [orgId, memberId, unitId, positionId],
      );
      membershipIds.push(m.rows[0].id);
    }
    return { positionId, membershipIds };
  }

  const orgId = randomUUID();
  const rootUnitId = randomUUID();
  const foreignOrgId = randomUUID();
  const foreignRootId = randomUUID();

  await owner.query("BEGIN");
  await owner.query(
    `INSERT INTO organizations(id, name) VALUES($1, 'T6 E2E Org'), ($2, 'T6 Foreign Org')`,
    [orgId, foreignOrgId],
  );
  await owner.query(
    `INSERT INTO units(organization_id, id, parent_id, name, kind)
     VALUES($1, $2, NULL, 'National Council', 'authority'),
           ($3, $4, NULL, 'Foreign National Council', 'authority')`,
    [orgId, rootUnitId, foreignOrgId, foreignRootId],
  );

  const rootMgrBundle = await createApprovedBundle(
    orgId,
    [
      "unit.read",
      "member.read",
      "unit.propose",
      "unit.approve",
      "unit.change.propose",
      "unit.change.approve",
      "membership.propose",
      "membership.approve",
      "position.propose",
      "position.approve",
      "governance.propose",
      "governance.vote",
      "governance.manage",
    ],
    "subtree",
  );
  const regionalMgrBundle = await createApprovedBundle(
    orgId,
    [
      "unit.read",
      "member.read",
      "channel.read",
      "channel.post",
      "channel.manage",
      "channel.moderate",
      "workitem.read",
      "workitem.create",
      "workitem.verify",
      "decision.read",
      "decision.manage",
      "decision.publish",
      "decision.vote",
    ],
    "subtree",
  );
  const ordinaryMemberBundle = await createApprovedBundle(
    orgId,
    [
      "unit.read",
      "channel.read",
      "channel.post",
      "workitem.read",
      "workitem.participate",
      "decision.read",
      "decision.vote",
    ],
    "unit",
  );
  const foreignBundle = await createApprovedBundle(
    foreignOrgId,
    ["unit.read", "channel.read", "channel.post", "workitem.read", "decision.read"],
    "unit",
  );

  const creatorMgr = await createActor("creator", "Root Creator", "admin", "web");
  const approverMgr = await createActor("approver", "Root Approver", "admin", "web");
  const tbRegionalMgr = await createActor("tbmgr", "Tbilisi Coordinator", "admin", "web");
  const memberOne = await createActor("member1", "Mobile Member One", "observer", "mobile");
  const siblingB = await createActor("siblingb", "Saburtalo Sibling B", "observer", "mobile");
  const kakhetiC = await createActor("kakhetic", "Telavi Member C", "observer", "mobile");
  const foreignUser = await createActor("foreign", "Foreign User", "observer", "mobile");

  await createPositionAndAssign(
    orgId,
    rootUnitId,
    "Root Governance Manager",
    rootMgrBundle,
    [creatorMgr.memberId, approverMgr.memberId],
  );
  await createPositionAndAssign(
    foreignOrgId,
    foreignRootId,
    "Foreign Member",
    foreignBundle,
    [foreignUser.memberId],
  );
  await owner.query("COMMIT");

  async function proposeAndApproveUnit(
    parentId: string,
    name: string,
    operationalType: "region" | "locality" | "group",
    geographicAreaId: string,
  ): Promise<{ unitId: string; mainChannelId: string | null }> {
    const proposed = await reqAdmin(creatorMgr, "post", "/units/reviews")
      .send({
        organizationId: orgId,
        parentId,
        name,
        operationalType,
        geographicAreaId,
        reason: `Create ${operationalType} ${name}`,
        expiresAt: futureIso(12),
        key: randomUUID(),
      })
      .expect(200);
    assert.equal(proposed.body.status, "pending");

    // Self-approval of unit proposal by creator must fail with 403
    await reqAdmin(creatorMgr, "post", "/units/decision")
      .send({
        organizationId: orgId,
        id: proposed.body.id,
        decision: "approved",
        reason: `Self-approve ${operationalType} ${name}`,
        key: randomUUID(),
      })
      .expect(403);

    const decided = await reqAdmin(approverMgr, "post", "/units/decision")
      .send({
        organizationId: orgId,
        id: proposed.body.id,
        decision: "approved",
        reason: `Approve ${operationalType} ${name}`,
        key: randomUUID(),
      })
      .expect(200);
    assert.equal(decided.body.status, "approved");
    assert.ok(decided.body.unitId);
    return {
      unitId: decided.body.unitId,
      mainChannelId: decided.body.mainChannelId ?? null,
    };
  }

  let tbilisiId = "";
  let saburtaloId = "";
  let groupAId = "";
  let groupAMainChannelId = "";
  let groupBId = "";
  let groupBMainChannelId = "";
  let kakhetiId = "";
  let telaviId = "";
  let groupCId = "";
  let groupCMainChannelId = "";

  await check("Phase 1: multi-region and sibling groups create -> approve with atomic main chats and zero implicit access", async () => {
    const tbilisi = await proposeAndApproveUnit(rootUnitId, "Tbilisi Region", "region", "GE-TB");
    tbilisiId = tbilisi.unitId;
    assert.equal(tbilisi.mainChannelId, null);

    const saburtalo = await proposeAndApproveUnit(tbilisiId, "Saburtalo District", "locality", "GE-TB-SABURTALO");
    saburtaloId = saburtalo.unitId;
    assert.equal(saburtalo.mainChannelId, null);

    const groupA = await proposeAndApproveUnit(saburtaloId, "Saburtalo Group A", "group", "GE-TB-SABURTALO");
    groupAId = groupA.unitId;
    assert.ok(groupA.mainChannelId);
    groupAMainChannelId = groupA.mainChannelId;

    const groupB = await proposeAndApproveUnit(saburtaloId, "Saburtalo Group B", "group", "GE-TB-SABURTALO");
    groupBId = groupB.unitId;
    assert.ok(groupB.mainChannelId);
    groupBMainChannelId = groupB.mainChannelId;
    assert.notEqual(groupAMainChannelId, groupBMainChannelId);

    const kakheti = await proposeAndApproveUnit(rootUnitId, "Kakheti Region", "region", "GE-KA");
    kakhetiId = kakheti.unitId;
    assert.equal(kakheti.mainChannelId, null);

    const telavi = await proposeAndApproveUnit(kakhetiId, "Telavi Municipality", "locality", "GE-KA-TELAVI");
    telaviId = telavi.unitId;
    assert.equal(telavi.mainChannelId, null);

    const groupC = await proposeAndApproveUnit(telaviId, "Telavi Group C", "group", "GE-KA-TELAVI");
    groupCId = groupC.unitId;
    assert.ok(groupC.mainChannelId);
    groupCMainChannelId = groupC.mainChannelId;

    // Cross-region containment mismatch must be rejected
    const badContainment = await reqAdmin(creatorMgr, "post", "/units/reviews").send({
      organizationId: orgId,
      parentId: saburtaloId,
      name: "Mismatched Kakheti Group",
      operationalType: "group",
      geographicAreaId: "GE-KA-TELAVI",
      reason: "Invalid cross-region placement",
      expiresAt: futureIso(12),
      key: randomUUID(),
    });
    assert.ok([400, 403, 409].includes(badContainment.status));

    // Creators/approvers receive zero implicit memberships or main-chat access in child groups
    const implicitCount = await owner.query(
      `SELECT count(*)::int AS cnt FROM memberships
       WHERE organization_id = $1 AND user_id IN ($2, $3) AND unit_id <> $4`,
      [orgId, creatorMgr.memberId, approverMgr.memberId, rootUnitId],
    );
    assert.equal(implicitCount.rows[0].cnt, 0);

    await reqAdmin(creatorMgr, "get", `/channels/thread?organizationId=${orgId}&id=${groupAMainChannelId}`).expect(403);
    await reqAdmin(approverMgr, "get", `/channels/thread?organizationId=${orgId}&id=${groupCMainChannelId}`).expect(403);
  });

  let groupAOrdinaryPos = "";
  let groupCOrdinaryPos = "";
  let groupAMembershipId = "";
  let groupCMembershipId = "";

  await check("Phase 2: publish group admission and admit mobile member across Tbilisi and Kakheti", async () => {
    await owner.query("BEGIN");
    const posA = await createPositionAndAssign(orgId, groupAId, "Group A Member", ordinaryMemberBundle);
    groupAOrdinaryPos = posA.positionId;
    await createPositionAndAssign(orgId, groupBId, "Group B Member", ordinaryMemberBundle, [siblingB.memberId]);
    const posC = await createPositionAndAssign(orgId, groupCId, "Group C Member", ordinaryMemberBundle, [kakhetiC.memberId]);
    groupCOrdinaryPos = posC.positionId;
    await createPositionAndAssign(orgId, tbilisiId, "Tbilisi Coordinator", regionalMgrBundle, [tbRegionalMgr.memberId]);
    await owner.query("COMMIT");

    // Before publishing, area browse must return zero open groups
    const beforePublish = await reqMobile(memberOne, "get", `/territory/groups?organizationId=${orgId}&areaId=GE-TB-SABURTALO`).expect(200);
    assert.equal(beforePublish.body.items.length, 0);

    // Group options returns least-privilege ordinary positions only; publish A and C, leave B closed
    const optionsA = await reqAdmin(approverMgr, "get", `/territory/group-options?organizationId=${orgId}&unitId=${groupAId}`).expect(200);
    assert.equal(optionsA.body.eligiblePositions.some((p: any) => p.id === groupAOrdinaryPos), true);

    await reqAdmin(approverMgr, "post", "/territory/group-settings")
      .send({ organizationId: orgId, unitId: groupAId, admissionOpen: true, admissionPositionId: groupAOrdinaryPos })
      .expect(200);
    await reqAdmin(approverMgr, "post", "/territory/group-settings")
      .send({ organizationId: orgId, unitId: groupCId, admissionOpen: true, admissionPositionId: groupCOrdinaryPos })
      .expect(200);

    const catalogue = await reqMobile(memberOne, "get", "/territory/catalogue").expect(200);
    assert.equal(catalogue.body.items.length, 85);

    const saburtaloGroups = await reqMobile(memberOne, "get", `/territory/groups?organizationId=${orgId}&areaId=GE-TB-SABURTALO`).expect(200);
    assert.deepEqual(
      saburtaloGroups.body.items.map((g: any) => g.id),
      [groupAId],
    );

    const telaviGroups = await reqMobile(memberOne, "get", `/territory/groups?organizationId=${orgId}&areaId=GE-KA-TELAVI`).expect(200);
    assert.deepEqual(
      telaviGroups.body.items.map((g: any) => g.id),
      [groupCId],
    );

    // Closed Group B rejects self-admission
    await reqMobile(memberOne, "post", "/territory/admissions")
      .send({ organizationId: orgId, unitId: groupBId, key: randomUUID(), reason: "Try closed sibling group" })
      .expect(403);

    const reqA = await reqMobile(memberOne, "post", "/territory/admissions")
      .send({ organizationId: orgId, unitId: groupAId, key: randomUUID(), reason: "Join Saburtalo Group A" })
      .expect(200);
    const reqC = await reqMobile(memberOne, "post", "/territory/admissions")
      .send({ organizationId: orgId, unitId: groupCId, key: randomUUID(), reason: "Join Telavi Group C" })
      .expect(200);

    // Mobile session attempting admin review decision is rejected with 401
    await reqAdmin(memberOne, "post", "/reviews/decision")
      .send({ organizationId: orgId, id: reqA.body.id, key: randomUUID(), decision: "approved", reason: "Self approve attempt" })
      .expect(401);

    // Independent approval succeeds
    await reqAdmin(approverMgr, "post", "/reviews/decision")
      .send({ organizationId: orgId, id: reqA.body.id, key: randomUUID(), decision: "approved", reason: "Approve Saburtalo Group A admission" })
      .expect(200);
    await reqAdmin(approverMgr, "post", "/reviews/decision")
      .send({ organizationId: orgId, id: reqC.body.id, key: randomUUID(), decision: "approved", reason: "Approve Telavi Group C admission" })
      .expect(200);

    const myGroups = await reqMobile(memberOne, "get", `/territory/my-groups?organizationId=${orgId}`).expect(200);
    assert.equal(myGroups.body.primaryMembershipId, null);
    assert.equal(myGroups.body.groups.length, 2);
    groupAMembershipId = myGroups.body.groups.find((g: any) => g.unitId === groupAId).membershipId;
    groupCMembershipId = myGroups.body.groups.find((g: any) => g.unitId === groupCId).membershipId;
    assert.ok(groupAMembershipId);
    assert.ok(groupCMembershipId);
  });

  let groupAAttachmentId = "";
  let tbInternalChannelId = "";
  let tbAnnouncementId = "";
  let tbAnnouncementAttachmentId = "";
  let groupATaskId = "";
  let groupAEventId = "";
  let groupADecisionId = "";

  await check("Phase 3: open main chat, post attachment & message, and consume targeted Group A + Tbilisi content", async () => {
    const bootBefore = await reqMobile(memberOne, "get", "/workspace/bootstrap").expect(200);
    assert.equal(bootBefore.body.groups.length, 2);
    assert.equal(bootBefore.body.groups.every((g: any) => g.isPrimary === false), true);

    await reqMobile(memberOne, "post", "/territory/primary-group")
      .send({ organizationId: orgId, membershipId: groupAMembershipId })
      .expect(200);

    const bootPrimaryA = await reqMobile(memberOne, "get", "/workspace/bootstrap").expect(200);
    const primaryAEntry = bootPrimaryA.body.groups.find((g: any) => g.unitId === groupAId);
    assert.equal(primaryAEntry.isPrimary, true);
    assert.equal(primaryAEntry.mainChannelId, groupAMainChannelId);

    const attUpload = await reqMobile(
      memberOne,
      "post",
      `/channels/attachment?organizationId=${orgId}&id=${groupAMainChannelId}&key=${randomUUID()}`,
    )
      .set("Content-Type", "image/png")
      .send(PNG_1X1)
      .expect(201);
    groupAAttachmentId = attUpload.body.id;

    await reqMobile(memberOne, "post", "/channels/post")
      .send({
        organizationId: orgId,
        id: groupAMainChannelId,
        body: "Hello Saburtalo Group A main chat",
        attachmentId: groupAAttachmentId,
        key: randomUUID(),
      })
      .expect(200);

    const threadA = await reqMobile(
      memberOne,
      "get",
      `/channels/thread?organizationId=${orgId}&id=${groupAMainChannelId}`,
    ).expect(200);
    assert.equal(threadA.body.items.length, 1);
    assert.equal(threadA.body.items[0].attachment.id, groupAAttachmentId);

    // Regional manager creates internal Tbilisi chat, Tbilisi-wide announcement, and Group A task/event/decision
    const tbInternal = await reqAdmin(tbRegionalMgr, "post", "/channels/create")
      .send({
        organizationId: orgId,
        unitId: tbilisiId,
        title: "Tbilisi Regional Coordinators",
        kind: "group",
        key: randomUUID(),
      })
      .expect(200);
    tbInternalChannelId = tbInternal.body.id;
    await reqAdmin(tbRegionalMgr, "post", "/channels/post")
      .send({ organizationId: orgId, id: tbInternalChannelId, body: "Internal regional brief", key: randomUUID() })
      .expect(200);

    const tbAnn = await reqAdmin(tbRegionalMgr, "post", "/channels/create")
      .send({
        organizationId: orgId,
        unitId: tbilisiId,
        title: "Tbilisi Wide Announcement",
        kind: "global",
        key: randomUUID(),
      })
      .expect(200);
    tbAnnouncementId = tbAnn.body.id;
    const tbAtt = await reqAdmin(
      tbRegionalMgr,
      "post",
      `/channels/attachment?organizationId=${orgId}&id=${tbAnnouncementId}&key=${randomUUID()}`,
    )
      .set("Content-Type", "image/png")
      .send(PNG_1X1)
      .expect(201);
    tbAnnouncementAttachmentId = tbAtt.body.id;
    await reqAdmin(tbRegionalMgr, "post", "/channels/post")
      .send({
        organizationId: orgId,
        id: tbAnnouncementId,
        body: "Announcement for Tbilisi units",
        attachmentId: tbAnnouncementAttachmentId,
        key: randomUUID(),
      })
      .expect(200);

    const taskRes = await reqAdmin(tbRegionalMgr, "post", "/work/create")
      .send({
        organizationId: orgId,
        unitId: groupAId,
        title: "Group A Task",
        description: "Targeted task for Saburtalo Group A",
        roleLabel: "Coordinator",
        priority: "high",
        capacity: 4,
        deadline: futureIso(48),
        key: randomUUID(),
      })
      .expect(200);
    groupATaskId = taskRes.body.id;

    const eventRes = await reqAdmin(tbRegionalMgr, "post", "/work/event_create")
      .send({
        organizationId: orgId,
        unitId: groupAId,
        title: "Group A Event",
        description: "Targeted meetup in Saburtalo",
        location: "Pekini Ave",
        startsAt: futureIso(10),
        endsAt: futureIso(12),
        contributionRuleId: null,
        key: randomUUID(),
      })
      .expect(200);
    groupAEventId = eventRes.body.id;

    const decRes = await reqAdmin(tbRegionalMgr, "post", "/decisions/create")
      .send({
        organizationId: orgId,
        unitId: groupAId,
        title: "Group A Poll",
        description: "Targeted vote for Saburtalo Group A",
        kind: "poll",
        privacy: "named",
        quorum: 1,
        includedUnitIds: [groupAId],
        excludedUnitIds: [],
        options: ["Approve", "Defer"],
        closesAt: futureIso(48),
        key: randomUUID(),
      })
      .expect(200);
    groupADecisionId = decRes.body.id;
    await reqAdmin(tbRegionalMgr, "post", "/decisions/publish")
      .send({ organizationId: orgId, id: groupADecisionId, version: 1, key: randomUUID() })
      .expect(200);

    // memberOne scoped to Group A sees Group A main chat + Tbilisi announcement, never Group C or internal Tbilisi
    const listA = await reqMobile(
      memberOne,
      "get",
      `/channels/list?organizationId=${orgId}&view=active&kind=member_all&unitId=${groupAId}`,
    ).expect(200);
    const idsA = listA.body.items.map((c: any) => c.id);
    assert.equal(idsA.includes(groupAMainChannelId), true);
    assert.equal(idsA.includes(tbAnnouncementId), true);
    assert.equal(idsA.includes(groupCMainChannelId), false);
    assert.equal(idsA.includes(tbInternalChannelId), false);

    // Descendant member can read/search/download Tbilisi announcement, sees empty participants, and cannot post
    await reqMobile(memberOne, "get", `/channels/thread?organizationId=${orgId}&id=${tbAnnouncementId}`).expect(200);
    const annSearch = await reqMobile(memberOne, "get", `/channels/search?organizationId=${orgId}&id=${tbAnnouncementId}&search=Announcement`).expect(200);
    assert.equal(annSearch.body.items.length, 1);
    await reqMobile(
      memberOne,
      "get",
      `/channels/attachment/download?organizationId=${orgId}&id=${tbAnnouncementId}&attachmentId=${tbAnnouncementAttachmentId}`,
    ).expect(200);
    const annParticipants = await reqMobile(memberOne, "get", `/channels/participants?organizationId=${orgId}&id=${tbAnnouncementId}`).expect(200);
    assert.equal(annParticipants.body.items.length, 0);
    await reqMobile(memberOne, "post", "/channels/post")
      .send({ organizationId: orgId, id: tbAnnouncementId, body: "Unauthorized reply", key: randomUUID() })
      .expect(403);
    await reqMobile(memberOne, "get", `/channels/thread?organizationId=${orgId}&id=${tbInternalChannelId}`).expect(403);

    // Work, event, and decision for Group A are visible and votable
    const workA = await reqMobile(memberOne, "get", `/work/list?organizationId=${orgId}&unitId=${groupAId}`).expect(200);
    assert.equal(workA.body.items.some((w: any) => w.id === groupATaskId), true);
    const eventsA = await reqMobile(memberOne, "get", `/work/event_list?organizationId=${orgId}&unitId=${groupAId}`).expect(200);
    assert.equal(eventsA.body.items.some((e: any) => e.id === groupAEventId), true);
    const decA = await reqMobile(memberOne, "get", `/decisions/list?organizationId=${orgId}&unitId=${groupAId}&view=open`).expect(200);
    assert.equal(decA.body.items.some((d: any) => d.id === groupADecisionId), true);
    await reqMobile(memberOne, "post", "/decisions/vote")
      .send({ organizationId: orgId, id: groupADecisionId, choice: 0, key: randomUUID() })
      .expect(200);
  });

  await check("Phase 4: switching active group to Kakheti Group C scopes feeds & excludes Tbilisi Group A content", async () => {
    await reqMobile(memberOne, "post", "/territory/primary-group")
      .send({ organizationId: orgId, membershipId: groupCMembershipId })
      .expect(200);

    const myGroups = await reqMobile(memberOne, "get", `/territory/my-groups?organizationId=${orgId}`).expect(200);
    assert.equal(myGroups.body.primaryMembershipId, groupCMembershipId);

    const listC = await reqMobile(
      memberOne,
      "get",
      `/channels/list?organizationId=${orgId}&view=active&kind=member_all&unitId=${groupCId}`,
    ).expect(200);
    const idsC = listC.body.items.map((c: any) => c.id);
    assert.deepEqual(idsC, [groupCMainChannelId]);
    assert.equal(idsC.includes(groupAMainChannelId), false);
    assert.equal(idsC.includes(tbAnnouncementId), false);

    const workC = await reqMobile(memberOne, "get", `/work/list?organizationId=${orgId}&unitId=${groupCId}`).expect(200);
    assert.equal(workC.body.items.some((w: any) => w.id === groupATaskId), false);
    const eventsC = await reqMobile(memberOne, "get", `/work/event_list?organizationId=${orgId}&unitId=${groupCId}`).expect(200);
    assert.equal(eventsC.body.items.some((e: any) => e.id === groupAEventId), false);
    const decC = await reqMobile(memberOne, "get", `/decisions/list?organizationId=${orgId}&unitId=${groupCId}&view=open`).expect(200);
    assert.equal(decC.body.items.some((d: any) => d.id === groupADecisionId), false);

    await reqMobile(memberOne, "post", "/channels/post")
      .send({ organizationId: orgId, id: groupCMainChannelId, body: "Hello Telavi Group C", key: randomUUID() })
      .expect(200);
    const threadC = await reqMobile(memberOne, "get", `/channels/thread?organizationId=${orgId}&id=${groupCMainChannelId}`).expect(200);
    assert.equal(threadC.body.items.length, 1);
  });

  await check("Phase 5: revoking Group C membership clears primary workspace without silent promotion and blocks retries", async () => {
    const versionRow = await owner.query(
      `SELECT version FROM memberships WHERE organization_id = $1 AND id = $2`,
      [orgId, groupCMembershipId],
    );
    const revokeReview = await reqAdmin(creatorMgr, "post", "/reviews/changes")
      .send({
        organizationId: orgId,
        membershipId: groupCMembershipId,
        version: versionRow.rows[0].version,
        kind: "revoke",
        reason: "End-to-end group C revocation test",
        expiresAt: futureIso(12),
        key: randomUUID(),
      })
      .expect(200);

    await reqAdmin(approverMgr, "post", "/reviews/decision")
      .send({
        organizationId: orgId,
        id: revokeReview.body.id,
        key: randomUUID(),
        decision: "approved",
        reason: "Independent approval of Group C revocation",
      })
      .expect(200);

    const myGroupsAfter = await reqMobile(memberOne, "get", `/territory/my-groups?organizationId=${orgId}`).expect(200);
    assert.equal(myGroupsAfter.body.primaryMembershipId, null);
    assert.equal(myGroupsAfter.body.groups.length, 1);
    assert.equal(myGroupsAfter.body.groups[0].unitId, groupAId);
    assert.equal(myGroupsAfter.body.groups[0].isPrimary, false);

    const bootAfter = await reqMobile(memberOne, "get", "/workspace/bootstrap").expect(200);
    assert.equal(bootAfter.body.groups.length, 1);
    assert.equal(bootAfter.body.groups[0].unitId, groupAId);
    assert.equal(bootAfter.body.groups[0].isPrimary, false);

    // Stale Group C retries: scoped list returns zero items and direct Group C mutations/reads return 403
    const listCAfter = await reqMobile(
      memberOne,
      "get",
      `/channels/list?organizationId=${orgId}&view=active&kind=member_all&unitId=${groupCId}`,
    ).expect(200);
    assert.deepEqual(listCAfter.body.items, []);
    await reqMobile(memberOne, "get", `/channels/thread?organizationId=${orgId}&id=${groupCMainChannelId}`).expect(403);
    await reqMobile(memberOne, "post", "/channels/post")
      .send({ organizationId: orgId, id: groupCMainChannelId, body: "Stale retry after revoke", key: randomUUID() })
      .expect(403);
    await reqMobile(memberOne, "get", `/work/list?organizationId=${orgId}&unitId=${groupCId}`).expect(403);
    const decCAfter = await reqMobile(memberOne, "get", `/decisions/list?organizationId=${orgId}&unitId=${groupCId}&view=open`).expect(200);
    assert.deepEqual(decCAfter.body.items, []);
    await reqMobile(memberOne, "post", "/territory/primary-group")
      .send({ organizationId: orgId, membershipId: groupCMembershipId })
      .expect(409);

    // Group A access remains intact
    await reqMobile(memberOne, "get", `/channels/thread?organizationId=${orgId}&id=${groupAMainChannelId}`).expect(200);
  });

  await check("Phase 6: strict sibling, cross-region, and cross-tenant isolation matrix", async () => {
    // Sibling Group B in same Saburtalo municipality sees Group B main chat + Tbilisi announcement, NEVER Group A
    const listB = await reqMobile(
      siblingB,
      "get",
      `/channels/list?organizationId=${orgId}&view=active&kind=member_all&unitId=${groupBId}`,
    ).expect(200);
    const idsB = listB.body.items.map((c: any) => c.id);
    assert.equal(idsB.includes(groupBMainChannelId), true);
    assert.equal(idsB.includes(tbAnnouncementId), true);
    assert.equal(idsB.includes(groupAMainChannelId), false);

    const listBSiblingQuery = await reqMobile(
      siblingB,
      "get",
      `/channels/list?organizationId=${orgId}&view=active&kind=member_all&unitId=${groupAId}`,
    ).expect(200);
    assert.equal(listBSiblingQuery.body.items.some((c: any) => c.id === groupAMainChannelId), false);
    await reqMobile(siblingB, "get", `/channels/thread?organizationId=${orgId}&id=${groupAMainChannelId}`).expect(403);
    await reqMobile(siblingB, "post", "/channels/post")
      .send({ organizationId: orgId, id: groupAMainChannelId, body: "Sibling intrusion attempt", key: randomUUID() })
      .expect(403);
    await reqMobile(siblingB, "get", `/channels/search?organizationId=${orgId}&id=${groupAMainChannelId}&search=Hello`).expect(403);
    await reqMobile(
      siblingB,
      "get",
      `/channels/attachment/download?organizationId=${orgId}&id=${groupAMainChannelId}&attachmentId=${groupAAttachmentId}`,
    ).expect(403);
    await reqMobile(siblingB, "get", `/work/list?organizationId=${orgId}&unitId=${groupAId}`).expect(403);
    const eventsBSibling = await reqMobile(siblingB, "get", `/work/event_list?organizationId=${orgId}&unitId=${groupAId}`).expect(200);
    assert.deepEqual(eventsBSibling.body.items, []);
    const decBSibling = await reqMobile(siblingB, "get", `/decisions/list?organizationId=${orgId}&unitId=${groupAId}&view=open`).expect(200);
    assert.deepEqual(decBSibling.body.items, []);
    await reqMobile(siblingB, "post", "/territory/primary-group")
      .send({ organizationId: orgId, membershipId: groupAMembershipId })
      .expect(403);

    // Kakheti Group C member cannot touch Tbilisi region or Saburtalo Group A
    const listKakheti = await reqMobile(
      kakhetiC,
      "get",
      `/channels/list?organizationId=${orgId}&view=active&kind=member_all&unitId=${groupCId}`,
    ).expect(200);
    assert.deepEqual(
      listKakheti.body.items.map((c: any) => c.id),
      [groupCMainChannelId],
    );
    await reqMobile(kakhetiC, "get", `/channels/thread?organizationId=${orgId}&id=${groupAMainChannelId}`).expect(403);
    await reqMobile(
      kakhetiC,
      "get",
      `/channels/attachment/download?organizationId=${orgId}&id=${groupAMainChannelId}&attachmentId=${groupAAttachmentId}`,
    ).expect(403);
    await reqMobile(kakhetiC, "get", `/channels/thread?organizationId=${orgId}&id=${tbAnnouncementId}`).expect(403);
    await reqMobile(
      kakhetiC,
      "get",
      `/channels/attachment/download?organizationId=${orgId}&id=${tbAnnouncementId}&attachmentId=${tbAnnouncementAttachmentId}`,
    ).expect(403);
    await reqMobile(kakhetiC, "get", `/work/list?organizationId=${orgId}&unitId=${groupAId}`).expect(403);

    // Foreign tenant user sees zero memberships in Org 1 and receives 403 on all Org 1 content & mutations
    const foreignMyGroups = await reqMobile(foreignUser, "get", `/territory/my-groups?organizationId=${orgId}`).expect(200);
    assert.deepEqual(foreignMyGroups.body.groups, []);
    assert.deepEqual(foreignMyGroups.body.pendingAdmissions, []);
    assert.equal(foreignMyGroups.body.primaryMembershipId, null);
    await reqMobile(foreignUser, "post", "/territory/primary-group")
      .send({ organizationId: orgId, membershipId: groupAMembershipId })
      .expect(403);
    await reqMobile(foreignUser, "get", `/channels/thread?organizationId=${orgId}&id=${groupAMainChannelId}`).expect(403);
    await reqMobile(foreignUser, "post", "/channels/post")
      .send({ organizationId: orgId, id: groupAMainChannelId, body: "Cross-tenant intrusion", key: randomUUID() })
      .expect(403);
    await reqMobile(
      foreignUser,
      "get",
      `/channels/attachment/download?organizationId=${orgId}&id=${groupAMainChannelId}&attachmentId=${groupAAttachmentId}`,
    ).expect(403);
    await reqMobile(foreignUser, "get", `/work/list?organizationId=${orgId}&unitId=${groupAId}`).expect(403);
    const foreignDecisions = await reqMobile(foreignUser, "get", `/decisions/list?organizationId=${orgId}&unitId=${groupAId}&view=open`).expect(200);
    assert.deepEqual(foreignDecisions.body.items, []);
    await reqMobile(foreignUser, "post", "/decisions/vote")
      .send({ organizationId: orgId, id: groupADecisionId, choice: 0, key: randomUUID() })
      .expect(403);
  });

  console.log(`ALL ${passed} TERRITORIAL E2E CHECKS PASSED`);
} finally {
  if (closeDb) await closeDb().catch(() => {});
  if (connected) await owner.end().catch(() => {});
  if (created) await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
  await control.end().catch(() => {});
}
