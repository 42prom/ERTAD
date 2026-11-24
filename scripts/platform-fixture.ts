import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { hashAdminPassword } from "../backend/src/services/adminPassword";
import { encryptSensitiveValue } from "../backend/src/services/secretEncryption";
import { generateMfaSecret } from "../backend/src/services/adminMfa";
import { SecurityService } from "../backend/src/services/security";

/** Local explicit upgrade; preserves credentials, expiry and revocation. */
export async function enablePlatformNetwork(client: Client, accountId: string, kind: "operator" | "reviewer" = "operator") {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "")) throw new Error("Local installer only");
  await client.query("SELECT pg_advisory_xact_lock(42420031)");
  const permissions = ['platform.network.read', kind === 'reviewer' ? 'platform.network.approve' : 'platform.network.propose'];
  const changed = await client.query(`UPDATE platform_accounts p SET permissions=(SELECT array_agg(DISTINCT permission) FROM unnest(p.permissions || $2::text[]) permission)
    WHERE p.admin_user_id=$1 AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
    AND 'platform.read'=ANY(p.permissions) AND NOT ($2::text[] <@ p.permissions)
    AND EXISTS(SELECT 1 FROM admin_users a WHERE a.id=p.admin_user_id AND a.is_active) RETURNING admin_user_id`, [accountId, permissions]);
  if (changed.rowCount) await SecurityService.logAuditEventInTransaction(client, 'PLATFORM_NETWORK_ACCESS_ENABLED', { adminUserId: accountId, local: true });
  return changed.rowCount === 1;
}

/** Explicit diagnostic upgrade; never activates a provider or renews authority. */
export async function enablePlatformIntegrations(
  client: Client,
  accountId: string,
) {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? ""))
    throw new Error("Local installer only");
  await client.query("SELECT pg_advisory_xact_lock(42420031)");
  const changed = await client.query(
    `UPDATE platform_accounts p SET permissions=(
    SELECT array_agg(DISTINCT permission) FROM unnest(p.permissions || ARRAY['platform.integrations.read','platform.integrations.test']) permission
    ) WHERE p.admin_user_id=$1 AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp()
    AND p.valid_until>clock_timestamp() AND 'platform.read'=ANY(p.permissions)
    AND NOT (ARRAY['platform.integrations.read','platform.integrations.test'] <@ p.permissions)
    AND EXISTS(SELECT 1 FROM admin_users a WHERE a.id=p.admin_user_id AND a.is_active) RETURNING admin_user_id`,
    [accountId],
  );
  if (changed.rowCount)
    await SecurityService.logAuditEventInTransaction(
      client,
      "PLATFORM_INTEGRATION_ACCESS_ENABLED",
      { adminUserId: accountId, local: true },
    );
  return changed.rowCount === 1;
}

/** Explicit development upgrade; preserves expiry, revocation and credentials. */
export async function enablePlatformSessionResponse(
  client: Client,
  accountId: string,
) {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? ""))
    throw new Error("Local installer only");
  await client.query("SELECT pg_advisory_xact_lock(42420031)");
  const changed = await client.query(
    `UPDATE platform_accounts p SET permissions=(
    SELECT array_agg(DISTINCT permission) FROM unnest(p.permissions || ARRAY['platform.sessions.read','platform.sessions.revoke']) permission
    ) WHERE p.admin_user_id=$1 AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp()
    AND p.valid_until>clock_timestamp() AND 'platform.read'=ANY(p.permissions)
    AND NOT (ARRAY['platform.sessions.read','platform.sessions.revoke'] <@ p.permissions)
    AND EXISTS(SELECT 1 FROM admin_users a WHERE a.id=p.admin_user_id AND a.is_active)
    RETURNING admin_user_id`,
    [accountId],
  );
  if (changed.rowCount)
    await SecurityService.logAuditEventInTransaction(
      client,
      "PLATFORM_SESSION_ACCESS_ENABLED",
      { adminUserId: accountId, local: true },
    );
  return changed.rowCount === 1;
}

/** Explicit local/test installer. Never called by HTTP or automatic migration. */
export async function enablePlatformAccountSecurity(client:Client,accountId:string,kind:'operator'|'reviewer'='operator'){
 if(!['development','test'].includes(process.env.NODE_ENV??''))throw new Error('Local installer only');
 await client.query('SELECT pg_advisory_xact_lock(42420031)');
 const permissions=kind==='reviewer'?['platform.accounts.read','platform.accounts.release','platform.accounts.approve']:['platform.accounts.read','platform.accounts.hold','platform.accounts.propose'];
 const changed=await client.query(`UPDATE platform_accounts p SET permissions=(SELECT array_agg(DISTINCT permission) FROM unnest(p.permissions || $2::text[]) permission)
 WHERE p.admin_user_id=$1 AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
 AND 'platform.read'=ANY(p.permissions) AND NOT ($2::text[] <@ p.permissions)
 AND EXISTS(SELECT 1 FROM admin_users a WHERE a.id=p.admin_user_id AND a.is_active) RETURNING admin_user_id`,[accountId,permissions]);
 if(changed.rowCount)await SecurityService.logAuditEventInTransaction(client,'PLATFORM_ACCOUNT_SECURITY_ENABLED',{adminUserId:accountId,local:true});
 return changed.rowCount===1;
}
/** Explicit local/test installer. Never called by HTTP or automatic migration. */
export async function seedPlatformOperator(
  client: Client,
  kind: "operator" | "reviewer" = "operator",
) {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? ""))
    throw new Error("Local installer only");
  await client.query("SELECT pg_advisory_xact_lock(42420031)");
  const email =
      kind === "reviewer"
        ? "platform-reviewer@ertad.local"
        : "platform@ertad.local",
    password = randomBytes(24).toString("base64url");
  if (
    (await client.query("SELECT 1 FROM admin_users WHERE email=$1", [email]))
      .rowCount
  )
    throw new Error("Existing technical account will not be reset");
  const account = (
    await client.query(
      `INSERT INTO admin_users(email,password_hash,role,full_name,mfa_secret_encrypted)
    VALUES($1,$2,'observer','ERTAD technical administrator',$3) RETURNING id`,
      [
        email,
        await hashAdminPassword(password),
        encryptSensitiveValue(generateMfaSecret()),
      ],
    )
  ).rows[0];
  const grant = (
    await client.query(
      `INSERT INTO platform_accounts(admin_user_id,permissions,valid_until)
    VALUES($1,$2,now()+interval '90 days') RETURNING valid_until`,
      [
        account.id,
        kind === "reviewer"
          ? [
              "platform.read",
              "platform.audit.read",
              "platform.policy.read",
              "platform.policy.approve",
            ]
          : ["platform.read", "platform.audit.read"],
      ],
    )
  ).rows[0];
  await SecurityService.logAuditEventInTransaction(
    client,
    "PLATFORM_BOOTSTRAPPED",
    { adminUserId: account.id, local: true },
  );
  return {
    id: account.id as string,
    email,
    password,
    validUntil: grant.valid_until,
  };
}

/** Explicit proposer upgrade; never installs approval authority or renews a grant. */
export async function enablePlatformPolicy(client: Client, accountId: string) {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? ""))
    throw new Error("Local installer only");
  await client.query("SELECT pg_advisory_xact_lock(42420031)");
  const changed = await client.query(
    `UPDATE platform_accounts p SET permissions=(
    SELECT array_agg(DISTINCT permission) FROM unnest(p.permissions || ARRAY['platform.policy.read','platform.policy.propose']) permission
    ) WHERE p.admin_user_id=$1 AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp()
    AND p.valid_until>clock_timestamp() AND 'platform.read'=ANY(p.permissions)
    AND NOT (ARRAY['platform.policy.read','platform.policy.propose'] <@ p.permissions)
    AND EXISTS(SELECT 1 FROM admin_users a WHERE a.id=p.admin_user_id AND a.is_active) RETURNING admin_user_id`,
    [accountId],
  );
  if (changed.rowCount)
    await SecurityService.logAuditEventInTransaction(
      client,
      "PLATFORM_POLICY_ACCESS_ENABLED",
      { adminUserId: accountId, local: true },
    );
  return changed.rowCount === 1;
}

/** Local explicit upgrade; preserves credentials, expiry and revocation. */
export async function enablePlatformLimits(client: Client, accountId: string, kind: "operator" | "reviewer" = "operator") {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "")) throw new Error("Local installer only");
  await client.query("SELECT pg_advisory_xact_lock(42420031)");
  const permissions = ['platform.limits.read', kind === 'reviewer' ? 'platform.limits.approve' : 'platform.limits.propose'];
  const changed = await client.query(`UPDATE platform_accounts p SET permissions=(SELECT array_agg(DISTINCT permission) FROM unnest(p.permissions || $2::text[]) permission)
    WHERE p.admin_user_id=$1 AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
    AND 'platform.read'=ANY(p.permissions) AND NOT ($2::text[] <@ p.permissions)
    AND EXISTS(SELECT 1 FROM admin_users a WHERE a.id=p.admin_user_id AND a.is_active) RETURNING admin_user_id`, [accountId, permissions]);
  if (changed.rowCount) await SecurityService.logAuditEventInTransaction(client, 'PLATFORM_LIMITS_ACCESS_ENABLED', { adminUserId: accountId, local: true });
  return changed.rowCount === 1;
}


/** Local explicit upgrade; preserves credentials, expiry and revocation. */
export async function enablePlatformProviders(client: Client, accountId: string, kind: "operator" | "reviewer" = "operator") {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "")) throw new Error("Local installer only");
  await client.query("SELECT pg_advisory_xact_lock(42420031)");
  const permissions = ['platform.providers.read', kind === 'reviewer' ? 'platform.providers.approve' : 'platform.providers.propose'];
  const changed = await client.query(`UPDATE platform_accounts p SET permissions=(SELECT array_agg(DISTINCT permission) FROM unnest(p.permissions || $2::text[]) permission)
    WHERE p.admin_user_id=$1 AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
    AND 'platform.read'=ANY(p.permissions) AND NOT ($2::text[] <@ p.permissions)
    AND EXISTS(SELECT 1 FROM admin_users a WHERE a.id=p.admin_user_id AND a.is_active) RETURNING admin_user_id`, [accountId, permissions]);
  if (changed.rowCount) await SecurityService.logAuditEventInTransaction(client, 'PLATFORM_PROVIDER_ACCESS_ENABLED', { adminUserId: accountId, local: true });
  return changed.rowCount === 1;
}

/** Local explicit upgrade for M4 biometric & mobile device security governance. */
export async function enablePlatformVerification(client: Client, accountId: string, kind: "operator" | "reviewer" = "operator") {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "")) throw new Error("Local installer only");
  await client.query("SELECT pg_advisory_xact_lock(42420031)");
  const permissions = kind === 'reviewer'
    ? ['platform.verification.read', 'platform.verification.approve', 'platform.mobile_devices.control']
    : ['platform.verification.read', 'platform.verification.propose', 'platform.mobile_devices.control'];
  const changed = await client.query(`UPDATE platform_accounts p SET permissions=(SELECT array_agg(DISTINCT permission) FROM unnest(p.permissions || $2::text[]) permission)
    WHERE p.admin_user_id=$1 AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
    AND 'platform.read'=ANY(p.permissions) AND NOT ($2::text[] <@ p.permissions)
    AND EXISTS(SELECT 1 FROM admin_users a WHERE a.id=p.admin_user_id AND a.is_active) RETURNING admin_user_id`, [accountId, permissions]);
  if (changed.rowCount) await SecurityService.logAuditEventInTransaction(client, 'PLATFORM_VERIFICATION_ACCESS_ENABLED', { adminUserId: accountId, local: true });
  return changed.rowCount === 1;
}

