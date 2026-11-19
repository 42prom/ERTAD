import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DemoAccess } from "../backend/src/localDemo";
import { SecurityService } from "../backend/src/services/security";

export async function enableDemoInvitations(
  client: Client,
  access: DemoAccess,
) {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? ""))
    throw new Error("Local synthetic fixtures only");
  await client.query("SELECT pg_advisory_xact_lock(42420007)");
  const org = access.organizationId,
    bundle = "b7b7fbd6-e166-478c-9ee1-6d86126e846e";
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
    if (
      !a.email.endsWith("@demo.ertad.local") ||
      !(
        await client.query(
          `SELECT 1 FROM admin_users a JOIN member_users m ON m.web_account_id=a.id
      WHERE a.id=$1 AND a.email=$2 AND m.id=$3 AND a.is_active AND m.status='active'
      AND EXISTS(SELECT 1 FROM memberships ms WHERE ms.organization_id=$4 AND ms.user_id=m.id AND ms.unit_id=$5
      AND ertad.member_membership_state(ms)='active' AND ms.valid_until>clock_timestamp())`,
          [a.id, a.email, a.memberId, org, a.unitId],
        )
      ).rowCount
    )
      throw new Error("Existing synthetic account binding required");
  }
  await client.query(
    "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
    [org, bundle],
  );
  for (const permission of [
    "unit.read",
    "account.invite.propose",
    "account.invite.approve",
    "governance.propose",
    "governance.vote",
  ])
    await client.query(
      "INSERT INTO permission_grants VALUES($1,$2,1,$3,'subtree')",
      [org, bundle, permission],
    );
  await client.query(
    "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
    [org, bundle],
  );
  const units = [...new Set(access.accounts.map((a) => a.unitId))];
  const memberBundle = randomUUID();
  await client.query(
    "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
    [org, memberBundle],
  );
  await client.query(
    "INSERT INTO permission_grants VALUES($1,$2,1,'unit.read','unit')",
    [org, memberBundle],
  );
  await client.query(
    "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
    [org, memberBundle],
  );
  for (const [index, unit] of units.entries()) {
    const position = randomUUID();
    await client.query(
      "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Web invitation administration demo',$4,1)",
      [org, position, unit, bundle],
    );
    for (const a of access.accounts.filter((a) => a.unitId === unit))
      await client.query(
        `INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until)
        SELECT $1,$2,$3,$4,1,now(),min(valid_until) FROM memberships WHERE organization_id=$1 AND user_id=$2 AND unit_id=$3
        AND status='active' AND valid_from<=now() AND valid_until>now()`,
        [org, a.memberId, unit, position],
      );
    if (index === 0) continue;
    const member = randomUUID(),
      memberPosition = randomUUID();
    await client.query("INSERT INTO member_users(id) VALUES($1)", [member]);
    await client.query(
      "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Invitation recipient demo',$4,1)",
      [org, memberPosition, unit, memberBundle],
    );
    await client.query(
      "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now()-interval '1 minute',now()+interval '90 days')",
      [org, member, unit, memberPosition],
    );
    await client.query(
      "INSERT INTO organization_member_labels(organization_id,member_id,display_name) VALUES($1,$2,$3)",
      [org, member, `სატესტო მიმღები ${index}`],
    );
    await client.query(
      "INSERT INTO web_invite_contacts(organization_id,unit_id,member_id,email,expires_at) VALUES($1,$2,$3,$4,now()+interval '90 days')",
      [
        org,
        unit,
        member,
        `recipient-${index}-${member.slice(0, 8)}@example.invalid`,
      ],
    );
  }
  await SecurityService.logAuditEventInTransaction(
    client,
    "LOCAL_INVITATIONS_ENABLED",
    { organizationId: org, synthetic: true },
  );
}
