import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DemoAccess } from "../backend/src/localDemo";
import { SecurityService } from "../backend/src/services/security";

/** Explicit local fixture upgrade; never restores expired/revoked grants or overwrites names. */
export async function enableDemoMembers(client: Client, access: DemoAccess) {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? ""))
    throw new Error("Local demo only");
  await client.query("SELECT pg_advisory_xact_lock(42420007)");
  const org = access.organizationId,
    bundle = "36c1c1fe-59bf-4e2c-9b4a-9721974ef830";
  if (
    (
      await client.query(
        "SELECT 1 FROM permission_bundles WHERE organization_id=$1 AND id=$2",
        [org, bundle],
      )
    ).rowCount
  )
    return;
  for (const a of access.accounts) {
    const result = await client.query(
      "SELECT 1 FROM member_users u JOIN admin_users a ON a.id=u.web_account_id WHERE u.id=$1 AND a.id=$2 AND a.email=$3 AND u.status='active' AND a.is_active AND ertad.review_has_scope(u.id,$4,$5,'membership.propose')",
      [a.memberId, a.id, a.email, org, a.unitId],
    );
    if (!result.rowCount)
      throw new Error("Current synthetic membership authority required");
  }
  await client.query(
    "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
    [org, bundle],
  );
  await client.query(
    "INSERT INTO permission_grants VALUES($1,$2,1,'member.read','subtree')",
    [org, bundle],
  );
  await client.query(
    "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
    [org, bundle],
  );
  for (const unit of new Set(access.accounts.map((a) => a.unitId))) {
    const position = randomUUID();
    await client.query(
      "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'წევრების მიმომხილველი',$4,1)",
      [org, position, unit, bundle],
    );
    for (const a of access.accounts.filter((a) => a.unitId === unit)) {
      await client.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) SELECT $1,$2,$3,$4,1,now(),least(min(valid_until),now()+interval '90 days') FROM memberships WHERE organization_id=$1 AND user_id=$2 AND unit_id=$3 AND status='active' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())",
        [org, a.memberId, unit, position],
      );
      await client.query(
        "INSERT INTO organization_member_labels VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [org, a.memberId, a.label],
      );
    }
  }
  await SecurityService.logAuditEventInTransaction(
    client,
    "LOCAL_WEB_DEMO_MEMBERS_ENABLED",
    { organizationId: org, synthetic: true },
  );
}
