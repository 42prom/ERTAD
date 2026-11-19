/**
 * Policy core for the first task journey. Inputs must be loaded from server state,
 * never request claims. A future domain transaction must read/lock current authority,
 * evaluate this policy and write the mutation + audit atomically. This function alone
 * supplies neither authentication, native evidence, governance approval nor persistence.
 */
export interface AuthoritySnapshot {
  user: { id: string; status: 'active' | 'suspended' };
  session: { userId: string; kind: 'web' | 'mobile'; expiresAt: number; revoked: boolean };
  organization: { id: string; status: 'active' | 'suspended' };
  units: readonly {
    id: string; organizationId: string; parentId: string | null; status: 'active' | 'archived';
  }[];
  memberships: readonly {
    id: string; userId: string; organizationId: string; unitId: string; positionId: string;
    status: 'active' | 'suspended' | 'ended'; validFrom: number; validUntil: number | null;
    bundleVersion: number;
  }[];
  positions: readonly {
    id: string; organizationId: string; unitId: string; status: 'active' | 'retired';
    bundleId: string; bundleVersion: number;
  }[];
  bundles: readonly {
    id: string; organizationId: string; version: number; status: 'approved' | 'draft' | 'revoked';
    grants: readonly { permission: string; scope: 'unit' | 'subtree' }[];
  }[];
}

export interface AccessTarget {
  organizationId: string;
  unitId: string;
  // Required for verification; taken from the work item and its assignments.
  workItem?: { completedByUserId: string; assigneeUserIds: readonly string[] };
}

type Denial = 'unsupported_operation' | 'invalid_session' | 'inactive_user'
  | 'wrong_organization' | 'invalid_hierarchy' | 'independent_verifier_required' | 'no_grant';
export type AccessDecision = { allowed: true; membershipId: string; bundleId: string; bundleVersion: number }
  | { allowed: false; reason: Denial };

function deny(reason: Denial): AccessDecision { return { allowed: false, reason }; }
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function evaluateScopedAccess(
  state: AuthoritySnapshot, operation: string, target: AccessTarget, now: number,
): AccessDecision {
  // Sensitive grants, membership/position changes and disclosure require separate Approval flows.
  if (!['unit.read', 'workitem.create', 'workitem.verify'].includes(operation)) return deny('unsupported_operation');
  const { user, session, organization } = state;
  if (!Number.isFinite(now) || !Number.isFinite(session.expiresAt) || session.expiresAt <= now
    || session.revoked !== false || !nonempty(user.id) || session.userId !== user.id
    || !['web', 'mobile'].includes(session.kind)) return deny('invalid_session');
  // Native action binding is not integrated yet; mobile mutations stay unavailable.
  if (session.kind === 'mobile' && operation !== 'unit.read') return deny('unsupported_operation');
  if (user.status !== 'active') return deny('inactive_user');
  if (!nonempty(organization.id) || organization.status !== 'active'
    || target.organizationId !== organization.id) return deny('wrong_organization');

  const units = new Map(state.units.map(unit => [unit.id, unit]));
  if (units.size !== state.units.length) return deny('invalid_hierarchy');
  function ancestors(id: string): Set<string> | null {
    const visited = new Set<string>();
    let current: string | null = id;
    while (current !== null) {
      if (!nonempty(current) || visited.has(current)) return null;
      const unit = units.get(current);
      if (!unit || unit.organizationId !== organization.id || unit.status !== 'active') return null;
      visited.add(current);
      current = unit.parentId;
    }
    return visited;
  }
  const path = ancestors(target.unitId);
  if (!path) return deny('invalid_hierarchy');
  if (operation === 'workitem.verify') {
    const item = target.workItem;
    if (!item || !nonempty(item.completedByUserId) || !Array.isArray(item.assigneeUserIds)
      || !item.assigneeUserIds.every(nonempty)
      || item.completedByUserId === user.id || item.assigneeUserIds.includes(user.id)) {
      return deny('independent_verifier_required');
    }
  }

  // Duplicate authority records are ambiguous; never choose a favorable copy.
  if (new Set(state.memberships.map(m => m.id)).size !== state.memberships.length
    || new Set(state.positions.map(p => p.id)).size !== state.positions.length
    || new Set(state.bundles.map(b => JSON.stringify([b.id, b.version]))).size !== state.bundles.length) {
    return deny('no_grant');
  }
  for (const membership of state.memberships) {
    if (!nonempty(membership.id) || membership.userId !== user.id
      || membership.organizationId !== organization.id || membership.status !== 'active'
      || !Number.isFinite(membership.validFrom) || membership.validFrom > now
      || (membership.validUntil !== null && (!Number.isFinite(membership.validUntil)
        || membership.validUntil <= now))
      || !Number.isSafeInteger(membership.bundleVersion) || membership.bundleVersion < 1
      || !ancestors(membership.unitId)) continue;
    const position = state.positions.find(p => p.id === membership.positionId);
    if (!position || !nonempty(position.id) || position.status !== 'active'
      || position.organizationId !== organization.id || position.unitId !== membership.unitId
      || position.bundleVersion !== membership.bundleVersion) continue;
    const bundle = state.bundles.find(b => b.id === position.bundleId && b.version === membership.bundleVersion);
    if (!bundle || !nonempty(bundle.id) || bundle.organizationId !== organization.id || bundle.status !== 'approved') continue;
    if (bundle.grants.some(grant => grant.permission === operation
      && ((grant.scope === 'unit' && membership.unitId === target.unitId)
        || (grant.scope === 'subtree' && path.has(membership.unitId))))) {
      return { allowed: true, membershipId: membership.id, bundleId: bundle.id, bundleVersion: bundle.version };
    }
  }
  return deny('no_grant');
}
