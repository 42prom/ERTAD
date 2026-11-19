import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DemoAccess } from "../backend/src/localDemo";
import { SecurityService } from "../backend/src/services/security";

/** Caller owns transaction; explicit offline demo upgrade, no resets. */
export async function enableDemoUnitChanges(
  client: Client,
  access: DemoAccess,
) {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? ""))
    throw new Error("Local demo only");
  await client.query("SELECT pg_advisory_xact_lock(42420007)");
  const org = access.organizationId,
    bundle = "87c25783-edc3-4515-b1e2-a9ab012d8b53";
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
    const valid = await client.query(
      `SELECT 1 FROM admin_users a JOIN member_users u ON u.web_account_id=a.id
      JOIN memberships m ON m.user_id=u.id WHERE a.id=$1 AND a.email=$2 AND u.id=$3 AND a.is_active AND u.status='active'
        AND m.organization_id=$4 AND m.unit_id=$5 AND m.status='active' AND m.valid_from<=now() AND m.valid_until>now()`,
      [a.id, a.email, a.memberId, org, a.unitId],
    );
    if (!a.email.endsWith("@demo.ertad.local") || !valid.rowCount)
      throw new Error("Active synthetic fixture membership required");
  }
  await client.query(
    "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
    [org, bundle],
  );
  for (const permission of [
    "unit.read",
    "unit.change.propose",
    "unit.change.approve",
  ])
    await client.query(
      "INSERT INTO permission_grants VALUES($1,$2,1,$3,'subtree')",
      [org, bundle, permission],
    );
  await client.query(
    "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
    [org, bundle],
  );
  for (const unit of new Set(access.accounts.map((a) => a.unitId))) {
    const position = randomUUID();
    await client.query(
      "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Unit lifecycle demo',$4,1)",
      [org, position, unit, bundle],
    );
    for (const a of access.accounts.filter((a) => a.unitId === unit))
      await client.query(
        `INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until)
      SELECT $1,$2,$3,$4,1,now(),min(valid_until) FROM memberships WHERE organization_id=$1 AND user_id=$2 AND unit_id=$3
        AND status='active' AND valid_from<=now() AND valid_until>now()`,
        [org, a.memberId, unit, position],
      );
  }
  await SecurityService.logAuditEventInTransaction(
    client,
    "LOCAL_WEB_DEMO_UNIT_CHANGES_ENABLED",
    { organizationId: org, synthetic: true },
  );
}
