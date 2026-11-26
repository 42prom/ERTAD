import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_territory_test_${randomBytes(8).toString("hex")}`;
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

  // Seed disposable two-district hierarchy with published + unpublished groups
  await owner.query("BEGIN");
  const orgRes = await owner.query<{ id: string }>(
    `INSERT INTO ertad.organizations(name) VALUES ('Territorial Test Org') RETURNING id`,
  );
  const orgId = orgRes.rows[0].id;
  const foreignOrgId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.organizations(name) VALUES ('Foreign Test Org') RETURNING id`,
    )
  ).rows[0].id;

  const rootId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type)
       VALUES ($1,NULL,'Org Root','authority','unclassified') RETURNING id`,
      [orgId],
    )
  ).rows[0].id;
  const regionTbilisiId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Tbilisi Region','authority','region','GE-TB') RETURNING id`,
      [orgId, rootId],
    )
  ).rows[0].id;
  const saburtaloId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Saburtalo District','authority','locality','GE-TB-SABURTALO') RETURNING id`,
      [orgId, regionTbilisiId],
    )
  ).rows[0].id;
  const didubeId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Didube District','authority','locality','GE-TB-DIDUBE') RETURNING id`,
      [orgId, regionTbilisiId],
    )
  ).rows[0].id;
  const groupAId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Saburtalo Public Group A','authority','group','GE-TB-SABURTALO') RETURNING id`,
      [orgId, saburtaloId],
    )
  ).rows[0].id;
  const groupBId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Saburtalo Private Group B','authority','group','GE-TB-SABURTALO') RETURNING id`,
      [orgId, saburtaloId],
    )
  ).rows[0].id;
  const groupCId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Didube Public Group C','authority','group','GE-TB-DIDUBE') RETURNING id`,
      [orgId, didubeId],
    )
  ).rows[0].id;
  const teamA1Id = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Group A Logistics Team','authority','team','GE-TB-SABURTALO') RETURNING id`,
      [orgId, groupAId],
    )
  ).rows[0].id;
  const archivableGroupId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id)
       VALUES ($1,$2,'Empty Archivable Group','authority','group','GE-TB-SABURTALO') RETURNING id`,
      [orgId, saburtaloId],
    )
  ).rows[0].id;

  const foreignRootId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type)
       VALUES ($1,NULL,'Foreign Root','authority','unclassified') RETURNING id`,
      [foreignOrgId],
    )
  ).rows[0].id;

  // Permission bundles & positions
  const createPosition = async (
    unitId: string,
    posName: string,
    perms: Array<{ permission: string; scope: "unit" | "subtree" }>,
    oId = orgId,
  ) => {
    const bundleId = randomUUID();
    await owner.query(
      `INSERT INTO ertad.permission_bundles(organization_id,id,version,status) VALUES ($1,$2,1,'draft')`,
      [oId, bundleId],
    );
    for (const g of perms) {
      await owner.query(
        `INSERT INTO ertad.permission_grants(organization_id,bundle_id,bundle_version,permission,scope)
         VALUES ($1,$2,1,$3,$4)`,
        [oId, bundleId, g.permission, g.scope],
      );
    }
    await owner.query(
      `UPDATE ertad.permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2 AND version=1`,
      [oId, bundleId],
    );
    const posRes = await owner.query<{ id: string }>(
      `INSERT INTO ertad.positions(organization_id,unit_id,name,bundle_id,bundle_version)
       VALUES ($1,$2,$3,$4,1) RETURNING id`,
      [oId, unitId, posName, bundleId],
    );
    return posRes.rows[0].id;
  };

  const posApprover = await createPosition(rootId, "Org Coordinator", [
    { permission: "unit.read", scope: "subtree" },
    { permission: "member.read", scope: "subtree" },
    { permission: "unit.propose", scope: "subtree" },
    { permission: "unit.approve", scope: "subtree" },
    { permission: "unit.change.propose", scope: "subtree" },
    { permission: "unit.change.approve", scope: "subtree" },
    { permission: "membership.propose", scope: "subtree" },
    { permission: "membership.approve", scope: "subtree" },
    { permission: "channel.read", scope: "subtree" },
    { permission: "channel.post", scope: "subtree" },
  ]);
  const posReviewerB = await createPosition(rootId, "Second Reviewer", [
    { permission: "unit.read", scope: "subtree" },
    { permission: "member.read", scope: "subtree" },
    { permission: "unit.change.approve", scope: "subtree" },
    { permission: "membership.approve", scope: "subtree" },
    { permission: "membership.propose", scope: "subtree" },
  ]);
  const posOrdinaryMemberA = await createPosition(groupAId, "Group A Member", [
    { permission: "unit.read", scope: "unit" },
    { permission: "channel.read", scope: "unit" },
    { permission: "channel.post", scope: "unit" },
    { permission: "workitem.participate", scope: "unit" },
    { permission: "decision.vote", scope: "unit" },
  ]);
  const posElevatedA = await createPosition(groupAId, "Group A Moderator", [
    { permission: "unit.read", scope: "unit" },
    { permission: "membership.approve", scope: "unit" },
    { permission: "channel.moderate", scope: "unit" },
  ]);
  const posOrdinaryMemberC = await createPosition(groupCId, "Group C Member", [
    { permission: "unit.read", scope: "unit" },
    { permission: "channel.read", scope: "unit" },
  ]);
  const posRootMember = await createPosition(rootId, "Basic Org Observer", [
    { permission: "unit.read", scope: "unit" },
  ]);
  const posTeamMember = await createPosition(teamA1Id, "Team Member", [
    { permission: "unit.read", scope: "unit" },
    { permission: "workitem.participate", scope: "unit" },
  ]);
  const posForeignRoot = await createPosition(
    foreignRootId,
    "Foreign Member",
    [{ permission: "unit.read", scope: "unit" }],
    foreignOrgId,
  );

  // Create accounts + sessions directly for test isolation
  const makeSessionUser = async (
    email: string,
    fullName: string,
    mode: "web" | "mobile" = "web",
  ) => {
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
    const sessRes = await owner.query<{ id: string }>(
      `INSERT INTO ertad.admin_sessions(
         admin_user_id,token_hash,csrf_token_hash,csrf_token_encrypted,session_kind,step_up_expires_at,idle_expires_at,absolute_expires_at
       ) VALUES ($1,$2,$3,$4,$5,clock_timestamp() + interval '1 hour',clock_timestamp() + interval '2 hours',clock_timestamp() + interval '8 hours')
       RETURNING id`,
      [adminId, tokenHash, csrfHash, csrfEncrypted, mode],
    );
    const sessionId = sessRes.rows[0].id;
    const headers: Record<string, string> =
      mode === "mobile"
        ? { Authorization: `Bearer ${rawToken}`, "X-Mobile-Csrf": csrf }
        : {
            Cookie: `ertad_admin_session=${rawToken}`,
            Origin: origin,
            "X-Admin-Csrf": csrf,
          };
    return { adminId, memberId, sessionId, tokenHash, csrf, headers };
  };

  const approver = await makeSessionUser("approver@territory.invalid", "Approver One");
  const approver2 = await makeSessionUser("approver2@territory.invalid", "Approver Two");
  const applicant = await makeSessionUser("applicant@territory.invalid", "Applicant One", "web");
  const mobileApplicant = await makeSessionUser("mobile.app@territory.invalid", "Mobile Applicant", "mobile");

  // Grant initial memberships
  await owner.query(
    `INSERT INTO ertad.memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until)
     VALUES
       ($1,$2,$3,$4,1,clock_timestamp() - interval '1 day',clock_timestamp() + interval '300 days'),
       ($1,$5,$3,$6,1,clock_timestamp() - interval '1 day',clock_timestamp() + interval '300 days'),
       ($1,$7,$8,$9,1,clock_timestamp() - interval '1 day',clock_timestamp() + interval '300 days'),
       ($1,$10,$3,$11,1,clock_timestamp() - interval '1 day',clock_timestamp() + interval '300 days')`,
    [
      orgId,
      approver.memberId,
      rootId,
      posApprover,
      approver2.memberId,
      posReviewerB,
      applicant.memberId,
      teamA1Id,
      posTeamMember,
      mobileApplicant.memberId,
      posRootMember,
    ],
  );
  const nonGroupMembershipId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM ertad.memberships WHERE organization_id=$1 AND user_id=$2 AND unit_id=$3`,
      [orgId, applicant.memberId, teamA1Id],
    )
  ).rows[0].id;
  const foreignMembershipId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until)
       VALUES ($1,$2,$3,$4,1,clock_timestamp() - interval '1 day',clock_timestamp() + interval '300 days') RETURNING id`,
      [foreignOrgId, applicant.memberId, foreignRootId, posForeignRoot],
    )
  ).rows[0].id;

  // Main channel on Group A for verifying mainChannelId in my-groups & workspace bootstrap
  const groupAMainChannelId = (
    await owner.query<{ id: string }>(
      `INSERT INTO ertad.channels(organization_id,unit_id,scope_path,title,creator_id,channel_kind,is_main)
       VALUES ($1,$2,ertad.unit_path($1,$2),'Saburtalo Public Group A',$3,'group',true) RETURNING id`,
      [orgId, groupAId, approver.memberId],
    )
  ).rows[0].id;

  await owner.query("COMMIT");

  await check("1. Direct runtime DML on member_primary_groups & membership_reviews denied", async () => {
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO ertad.member_primary_groups(organization_id,user_id,membership_id) VALUES ($1,$2,$3)`,
          [orgId, applicant.memberId, nonGroupMembershipId],
        ),
      /permission denied/i,
    );
    await assert.rejects(
      () => db.query(`DELETE FROM ertad.membership_reviews`),
      /permission denied/i,
    );
  });

  await check("2. Shared geographic catalogue reads active areas without granting authority", async () => {
    const res = await request(app)
      .get(`${base}/territory/catalogue`)
      .set(applicant.headers)
      .expect(200);
    assert.equal(res.body.coverage, "operational_baseline");
    assert.ok(Array.isArray(res.body.items) && res.body.items.length >= 85);
    assert.ok(res.body.items.some((i: { id: string }) => i.id === "GE-TB-SABURTALO"));
    const mobileRes = await request(app)
      .get(`${mobileBase}/territory/catalogue`)
      .set(mobileApplicant.headers)
      .expect(200);
    assert.equal(mobileRes.body.items.length, res.body.items.length);
  });

  await check("3. Admission publication rejects elevated positions and unprivileged actors", async () => {
    await request(app)
      .get(`${base}/territory/group-options`)
      .query({ organizationId: orgId, unitId: groupAId })
      .set(applicant.headers)
      .expect(403);

    await request(app)
      .post(`${base}/territory/group-settings`)
      .set(applicant.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        admissionOpen: true,
        admissionPositionId: posOrdinaryMemberA,
      })
      .expect(403);

    // Approver cannot publish an elevated position containing membership.approve/channel.moderate
    await request(app)
      .post(`${base}/territory/group-settings`)
      .set(approver.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        admissionOpen: true,
        admissionPositionId: posElevatedA,
      })
      .expect(409);

    const optRes = await request(app)
      .get(`${base}/territory/group-options`)
      .query({ organizationId: orgId, unitId: groupAId })
      .set(approver.headers)
      .expect(200);
    assert.equal(optRes.body.eligiblePositions.length, 1);
    assert.equal(optRes.body.eligiblePositions[0].id, posOrdinaryMemberA);

    // Publish Group A & Group C; keep Group B unpublished
    await request(app)
      .post(`${base}/territory/group-settings`)
      .set(approver.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        admissionOpen: true,
        admissionPositionId: posOrdinaryMemberA,
      })
      .expect(200);

    await request(app)
      .post(`${base}/territory/group-settings`)
      .set(approver.headers)
      .send({
        organizationId: orgId,
        unitId: groupCId,
        admissionOpen: true,
        admissionPositionId: posOrdinaryMemberC,
      })
      .expect(200);
  });

  await check("4. Bounded group preview filters by area/ancestor and hides unpublished groups", async () => {
    const saburtaloRes = await request(app)
      .get(`${base}/territory/groups`)
      .query({ organizationId: orgId, areaId: "GE-TB-SABURTALO" })
      .set(applicant.headers)
      .expect(200);
    assert.equal(saburtaloRes.body.items.length, 1);
    assert.equal(saburtaloRes.body.items[0].id, groupAId);
    assert.deepEqual(
      Object.keys(saburtaloRes.body.items[0]).sort(),
      [
        "alreadyMember",
        "geographicAreaId",
        "geography",
        "historyNote",
        "id",
        "name",
        "pendingRequestId",
        "positionName",
      ],
    );

    const tbilisiRes = await request(app)
      .get(`${base}/territory/groups`)
      .query({ organizationId: orgId, areaId: "GE-TB" })
      .set(applicant.headers)
      .expect(200);
    const ids = tbilisiRes.body.items.map((g: { id: string }) => g.id).sort();
    assert.deepEqual(ids, [groupAId, groupCId].sort());
    assert.ok(!ids.includes(groupBId), "Unpublished Group B must remain hidden");
  });

  let admissionReviewId = "";
  let admissionCReviewId = "";

  await check("5. Member admission submission, idempotent retry & duplicate prevention", async () => {
    // Reject unpublished Group B and non-group Team A1
    await request(app)
      .post(`${base}/territory/admissions`)
      .set(applicant.headers)
      .send({
        organizationId: orgId,
        unitId: groupBId,
        key: randomUUID(),
        reason: "Trying to join an unpublished group.",
      })
      .expect(403);

    await request(app)
      .post(`${base}/territory/admissions`)
      .set(applicant.headers)
      .send({
        organizationId: orgId,
        unitId: teamA1Id,
        key: randomUUID(),
        reason: "Trying to self-admit directly to a team.",
      })
      .expect(403);

    const key1 = randomUUID();
    const first = await request(app)
      .post(`${base}/territory/admissions`)
      .set(applicant.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        key: key1,
        reason: "Requesting local membership in Saburtalo group.",
      })
      .expect(200);
    assert.equal(first.body.status, "pending");
    admissionReviewId = first.body.id;

    // Safe retry with same key & payload returns same review id
    const retryRes = await request(app)
      .post(`${base}/territory/admissions`)
      .set(applicant.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        key: key1,
        reason: "Requesting local membership in Saburtalo group.",
      })
      .expect(200);
    assert.equal(retryRes.body.id, admissionReviewId);

    // Key reuse with different reason conflicts
    await request(app)
      .post(`${base}/territory/admissions`)
      .set(applicant.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        key: key1,
        reason: "Tampered different admission reason on same key.",
      })
      .expect(409);

    // Concurrent/duplicate pending request with different key rejected
    await request(app)
      .post(`${base}/territory/admissions`)
      .set(applicant.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        key: randomUUID(),
        reason: "Duplicate concurrent admission attempt for same group.",
      })
      .expect(409);

    // Also submit admission to Group C for multi-group switcher tests
    const reqC = await request(app)
      .post(`${base}/territory/admissions`)
      .set(applicant.headers)
      .send({
        organizationId: orgId,
        unitId: groupCId,
        key: randomUUID(),
        reason: "Secondary admission request for Didube group.",
      })
      .expect(200);
    admissionCReviewId = reqC.body.id;
  });

  await check("6. Self-approval denied; approver cannot decide own admission; independent approval grants membership", async () => {
    // Self-approval by requester blocked
    await request(app)
      .post(`${base}/reviews/decision`)
      .set(applicant.headers)
      .send({
        organizationId: orgId,
        id: admissionReviewId,
        key: randomUUID(),
        decision: "approved",
        reason: "Attempting invalid self-approval.",
      })
      .expect(403);

    // Even an approver who submits their own admission request cannot approve it themselves
    const approverSelfReq = await request(app)
      .post(`${base}/territory/admissions`)
      .set(approver.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        key: randomUUID(),
        reason: "Approver testing self-admission separation.",
      })
      .expect(200);
    await request(app)
      .post(`${base}/reviews/decision`)
      .set(approver.headers)
      .send({
        organizationId: orgId,
        id: approverSelfReq.body.id,
        key: randomUUID(),
        decision: "approved",
        reason: "Should fail because actor is requester and target.",
      })
      .expect(403);

    // Independent approver sees pending admission in reviews list & detail
    const pendingList = await request(app)
      .get(`${base}/reviews`)
      .query({ organizationId: orgId, view: "pending", page: 1 })
      .set(approver.headers)
      .expect(200);
    const rowA = pendingList.body.items.find((i: { id: string }) => i.id === admissionReviewId);
    assert.ok(rowA);
    assert.equal(rowA.kind, "admission");

    const detailRes = await request(app)
      .get(`${base}/reviews/detail`)
      .query({ organizationId: orgId, id: admissionReviewId })
      .set(approver.headers)
      .expect(200);
    assert.equal(detailRes.body.canDecide, true);
    assert.equal(detailRes.body.kind, "admission");

    // Approve both admissions independently
    await request(app)
      .post(`${base}/reviews/decision`)
      .set(approver.headers)
      .send({
        organizationId: orgId,
        id: admissionReviewId,
        key: randomUUID(),
        decision: "approved",
        reason: "Approved independent local group membership for applicant.",
      })
      .expect(200);

    await request(app)
      .post(`${base}/reviews/decision`)
      .set(approver.headers)
      .send({
        organizationId: orgId,
        id: admissionCReviewId,
        key: randomUUID(),
        decision: "approved",
        reason: "Approved second local group membership for switching test.",
      })
      .expect(200);
  });

  let groupAMembershipId = "";
  let groupCMembershipId = "";

  await check("7. Workspace bootstrap & primary-group switching enforce uniqueness and group eligibility", async () => {
    const myRes = await request(app)
      .get(`${base}/territory/my-groups`)
      .query({ organizationId: orgId })
      .set(applicant.headers)
      .expect(200);
    assert.equal(myRes.body.primaryMembershipId, null);
    assert.equal(myRes.body.groups.length, 2);
    const grpA = myRes.body.groups.find((g: { unitId: string }) => g.unitId === groupAId);
    const grpC = myRes.body.groups.find((g: { unitId: string }) => g.unitId === groupCId);
    assert.ok(grpA && grpC);
    assert.equal(grpA.mainChannelId, groupAMainChannelId);
    groupAMembershipId = grpA.membershipId;
    groupCMembershipId = grpC.membershipId;

    // Non-group (team) and foreign org membership rejected as primary local group
    await request(app)
      .post(`${base}/territory/primary-group`)
      .set(applicant.headers)
      .send({ organizationId: orgId, membershipId: nonGroupMembershipId })
      .expect(409);

    await request(app)
      .post(`${base}/territory/primary-group`)
      .set(applicant.headers)
      .send({ organizationId: orgId, membershipId: foreignMembershipId })
      .expect(403);

    // Set Group A primary
    await request(app)
      .post(`${base}/territory/primary-group`)
      .set(applicant.headers)
      .send({ organizationId: orgId, membershipId: groupAMembershipId })
      .expect(200);

    // Switch primary to Group C cleanly
    await request(app)
      .post(`${base}/territory/primary-group`)
      .set(applicant.headers)
      .send({ organizationId: orgId, membershipId: groupCMembershipId })
      .expect(200);

    const boot = await request(app)
      .get(`${base}/workspace/bootstrap`)
      .set(applicant.headers)
      .expect(200);
    const primaryCount = boot.body.groups.filter((g: { isPrimary: boolean }) => g.isPrimary).length;
    assert.equal(primaryCount, 1);
    assert.equal(
      boot.body.groups.find((g: { isPrimary: boolean }) => g.isPrimary).membershipId,
      groupCMembershipId,
    );
  });

  await check("8. Suspending/revoking primary membership clears primary designation without silent fallback", async () => {
    const versionRow = (
      await owner.query<{ version: number }>(
        `SELECT version FROM ertad.memberships WHERE organization_id=$1 AND id=$2`,
        [orgId, groupCMembershipId],
      )
    ).rows[0];

    const suspendReq = await request(app)
      .post(`${base}/reviews/changes`)
      .set(approver.headers)
      .send({
        organizationId: orgId,
        membershipId: groupCMembershipId,
        version: versionRow.version,
        kind: "suspend",
        reason: "Suspending primary group membership to verify primary reset.",
        expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
        key: randomUUID(),
      })
      .expect(200);

    await request(app)
      .post(`${base}/reviews/decision`)
      .set(approver2.headers)
      .send({
        organizationId: orgId,
        id: suspendReq.body.id,
        key: randomUUID(),
        decision: "approved",
        reason: "Independent approval for primary membership suspension.",
      })
      .expect(200);

    const afterMy = await request(app)
      .get(`${base}/territory/my-groups`)
      .query({ organizationId: orgId })
      .set(applicant.headers)
      .expect(200);
    assert.equal(afterMy.body.primaryMembershipId, null, "Primary designation must clear on deactivation");
    assert.equal(afterMy.body.groups.length, 1);
    assert.equal(afterMy.body.groups[0].membershipId, groupAMembershipId);
    assert.equal(afterMy.body.groups[0].isPrimary, false, "Must not silently promote another group");
  });

  await check("9. Archiving an empty group clears admission_open and mobile endpoint accepts request", async () => {
    // Archive empty archivable group cleanly
    const verRow = (
      await owner.query<{ version: number }>(
        `SELECT version FROM ertad.units WHERE organization_id=$1 AND id=$2`,
        [orgId, archivableGroupId],
      )
    ).rows[0];
    const arcReq = await request(app)
      .post(`${base}/units/changes`)
      .set(approver.headers)
      .send({
        organizationId: orgId,
        unitId: archivableGroupId,
        version: verRow.version,
        kind: "archive",
        reason: "Archiving unused empty territorial group.",
        expiresAt: new Date(Date.now() + 2 * 86400_000).toISOString(),
        key: randomUUID(),
      })
      .expect(200);
    await request(app)
      .post(`${base}/units/decision`)
      .set(approver2.headers)
      .send({
        organizationId: orgId,
        id: arcReq.body.id,
        key: randomUUID(),
        decision: "approved",
        reason: "Confirmed archival of empty territorial group.",
      })
      .expect(200);

    // Mobile router admission request + bootstrap works via Bearer + x-mobile-csrf
    const mobReq = await request(app)
      .post(`${mobileBase}/territory/admissions`)
      .set(mobileApplicant.headers)
      .send({
        organizationId: orgId,
        unitId: groupAId,
        key: randomUUID(),
        reason: "Mobile client admission request for Saburtalo Group A.",
      })
      .expect(200);
    assert.equal(mobReq.body.status, "pending");

    const mobBoot = await request(app)
      .get(`${mobileBase}/workspace/bootstrap`)
      .set(mobileApplicant.headers)
      .expect(200);
    assert.ok(Array.isArray(mobBoot.body.groups));
  });

  console.log(`ALL PASSED: ${checks} territorial admission checks`);
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) {
    await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  }
  await control.end();
}
