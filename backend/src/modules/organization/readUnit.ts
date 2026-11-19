import { transaction } from '../../db/client';
import { SecurityService } from '../../services/security';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { evaluateScopedAccess, type AuthoritySnapshot } from './accessPolicy';

export class ScopedAccessDenied extends Error {
  readonly statusCode = 403;
  readonly code = 'ACCESS_DENIED';
  readonly isOperational = true;
  constructor() { super('Access denied'); }
}

export interface UnitProjection {
  id: string;
  organizationId: string;
  parentId: string | null;
  name: string;
  kind: 'authority' | 'professional' | 'project';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Internal read contract; no public route or membership bootstrap is enabled yet.
 * session is supplied by server authentication, never by JSON/headers/role claims.
 * Reuses the existing web session and strict audit transaction, without assigning it
 * a member identity or permission implicitly. Locks are held until audit + commit.
 */
export async function readUnitForWebSession(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  organizationId: string,
  unitId: string,
): Promise<UnitProjection> {
  if (![session.sessionId, organizationId, unitId].every(value => typeof value === 'string' && UUID.test(value))
    || !/^[0-9a-f]{64}$/.test(session.sessionTokenHash)) throw new ScopedAccessDenied();
  return transaction(async client => {
    // Authority triggers serialize changes on the organization row; use a fresh
    // statement snapshot after waiting for its shared lock.
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    let memberId: string;
    try {
      const locked = await client.query<{ member_id: string }>(
        'SELECT ertad.lock_web_authority($1, $2, $3) AS member_id',
        [session.sessionId, session.sessionTokenHash, organizationId],
      );
      memberId = locked.rows[0].member_id;
    } catch (error) {
      if ((error as { code?: string }).code === '42501') throw new ScopedAccessDenied();
      throw error;
    }
    const identity = (await client.query<{
      status: 'active' | 'suspended'; active: boolean; lockedUntil: Date | null;
      expiresAt: number; revoked: boolean; organizationStatus: 'active' | 'suspended';
    }>(`SELECT m.status, a.is_active AS active, a.locked_until AS "lockedUntil",
               extract(epoch FROM LEAST(s.idle_expires_at, s.absolute_expires_at)) * 1000::float8 AS "expiresAt",
               s.revoked_at IS NOT NULL AS revoked, o.status AS "organizationStatus"
          FROM ertad.member_users m
          JOIN ertad.admin_users a ON a.id = m.web_account_id
          JOIN ertad.admin_sessions s ON s.admin_user_id = a.id
          CROSS JOIN ertad.organizations o
         WHERE m.id = $1 AND s.id = $2 AND s.token_hash = $3 AND o.id = $4`,
    [memberId, session.sessionId, session.sessionTokenHash, organizationId])).rows[0];
    if (!identity) throw new ScopedAccessDenied();
    const memberships = (await client.query<AuthoritySnapshot['memberships'][number]>(`
      SELECT id, user_id AS "userId", organization_id AS "organizationId", unit_id AS "unitId",
             position_id AS "positionId", status, bundle_version AS "bundleVersion",
             extract(epoch FROM valid_from) * 1000::float8 AS "validFrom",
             extract(epoch FROM valid_until) * 1000::float8 AS "validUntil"
        FROM ertad.memberships WHERE organization_id = $1 AND user_id = $2 ORDER BY id`,
    [organizationId, memberId])).rows;
    const positions = (await client.query<AuthoritySnapshot['positions'][number]>(`
      SELECT id, organization_id AS "organizationId", unit_id AS "unitId", status,
             bundle_id AS "bundleId", bundle_version AS "bundleVersion"
        FROM ertad.positions WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
    [organizationId, memberships.map(m => m.positionId)])).rows;
    const bundles = (await client.query<AuthoritySnapshot['bundles'][number]>(`
      SELECT b.id, b.organization_id AS "organizationId", b.version, b.status,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('permission', g.permission, 'scope', g.scope)
                 ORDER BY g.permission, g.scope) FROM ertad.permission_grants g
               WHERE g.organization_id = b.organization_id AND g.bundle_id = b.id AND g.bundle_version = b.version), '[]') AS grants
        FROM ertad.permission_bundles b
       WHERE b.organization_id = $1 AND EXISTS (
         SELECT 1 FROM ertad.positions p WHERE p.organization_id = b.organization_id
           AND p.id = ANY($2::uuid[]) AND p.bundle_id = b.id AND p.bundle_version = b.version)
       ORDER BY b.id, b.version`, [organizationId, positions.map(p => p.id)])).rows;
    // Fetch only the target/membership ancestor closure, never an entire directory.
    const units = (await client.query<AuthoritySnapshot['units'][number] & UnitProjection>(`
      WITH RECURSIVE ancestry AS (
        SELECT * FROM ertad.units WHERE organization_id = $1 AND id = ANY($2::uuid[])
        UNION
        SELECT u.* FROM ertad.units u JOIN ancestry a ON u.id = a.parent_id
          WHERE u.organization_id = $1
      ) SELECT id, organization_id AS "organizationId", parent_id AS "parentId", status, name, kind
          FROM ancestry ORDER BY id`, [organizationId, [unitId, ...memberships.map(m => m.unitId)]])).rows;
    const state: AuthoritySnapshot = {
      user: { id: memberId, status: identity.status },
      session: { userId: memberId, kind: 'web', expiresAt: identity.expiresAt, revoked: identity.revoked },
      organization: { id: organizationId, status: identity.organizationStatus },
      units, memberships, positions, bundles,
    };
    const authorize = async () => {
      const now = (await client.query<{ now: number }>('SELECT extract(epoch FROM clock_timestamp()) * 1000::float8 AS now')).rows[0].now;
      if (!identity.active || (identity.lockedUntil && identity.lockedUntil.getTime() > now)) throw new ScopedAccessDenied();
      const decision = evaluateScopedAccess(state, 'unit.read', { organizationId, unitId }, now);
      if (!decision.allowed) throw new ScopedAccessDenied();
      return decision;
    };
    const grant = await authorize();
    const unit = units.find(row => row.id === unitId)!;
    await SecurityService.logAuditEventInTransaction(client, 'UNIT_READ', {
      organizationId, unitId, userId: memberId, membershipId: grant.membershipId,
      bundleId: grant.bundleId, bundleVersion: grant.bundleVersion,
    });
    // Waiting for the audit-chain lock can cross an expiry boundary.
    await authorize();
    return { id: unit.id, organizationId: unit.organizationId, parentId: unit.parentId, name: unit.name, kind: unit.kind };
  });
}
