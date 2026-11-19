import { AccessTarget, AuthoritySnapshot, evaluateScopedAccess } from '../src/modules/organization/accessPolicy';

const now = 1791072000000;
const target: AccessTarget = {
  organizationId: 'org-a', unitId: 'local',
  workItem: { completedByUserId: 'worker', assigneeUserIds: ['worker'] },
};
function fixture(): AuthoritySnapshot {
  return {
    user: { id: 'reviewer', status: 'active' },
    session: { userId: 'reviewer', kind: 'web', expiresAt: now + 1000, revoked: false },
    organization: { id: 'org-a', status: 'active' },
    units: [
      { id: 'root', organizationId: 'org-a', parentId: null, status: 'active' },
      { id: 'local', organizationId: 'org-a', parentId: 'root', status: 'active' },
      { id: 'professional', organizationId: 'org-a', parentId: 'root', status: 'active' },
    ],
    memberships: [{ id: 'membership', userId: 'reviewer', organizationId: 'org-a', unitId: 'root',
      positionId: 'position', status: 'active', validFrom: now, validUntil: null, bundleVersion: 1 }],
    positions: [{ id: 'position', organizationId: 'org-a', unitId: 'root', status: 'active',
      bundleId: 'bundle', bundleVersion: 1 }],
    bundles: [{ id: 'bundle', organizationId: 'org-a', version: 1, status: 'approved', grants: [
      { permission: 'unit.read', scope: 'subtree' },
      { permission: 'workitem.create', scope: 'subtree' },
      { permission: 'workitem.verify', scope: 'subtree' },
    ] }],
  };
}

describe('first journey scoped authorization policy', () => {
  it.each(['unit.read', 'workitem.create', 'workitem.verify'])('allows %s with complete current authority', operation => {
    expect(evaluateScopedAccess(fixture(), operation, target, now)).toEqual({
      allowed: true, membershipId: 'membership', bundleId: 'bundle', bundleVersion: 1,
    });
  });

  const invalidStates: [string, (s: AuthoritySnapshot) => void][] = [
    ['expired session', s => { s.session.expiresAt = now; }],
    ['revoked session', s => { s.session.revoked = true; }],
    ['another user session', s => { s.session.userId = 'other'; }],
    ['suspended user', s => { s.user.status = 'suspended'; }],
    ['suspended organization', s => { s.organization.status = 'suspended'; }],
    ['suspended membership', s => { s.memberships[0].status = 'suspended'; }],
    ['ended membership', s => { s.memberships[0].status = 'ended'; }],
    ['future membership', s => { s.memberships[0].validFrom = now + 1; }],
    ['expired membership', s => { s.memberships[0].validUntil = now; }],
    ['invalid membership time', s => { s.memberships[0].validFrom = NaN; }],
    ['another user membership', s => { s.memberships[0].userId = 'other'; }],
    ['another organization membership', s => { s.memberships[0].organizationId = 'org-b'; }],
    ['retired position', s => { s.positions[0].status = 'retired'; }],
    ['cross-unit position', s => { s.positions[0].unitId = 'local'; }],
    ['cross-organization position', s => { s.positions[0].organizationId = 'org-b'; }],
    ['stale bundle reference', s => { s.positions[0].bundleVersion = 2; }],
    ['unapproved bundle', s => { s.bundles[0].status = 'draft'; }],
    ['revoked bundle', s => { s.bundles[0].status = 'revoked'; }],
    ['cross-organization bundle', s => { s.bundles[0].organizationId = 'org-b'; }],
    ['wrong permission', s => { s.bundles[0].grants = [{ permission: 'unit.read', scope: 'subtree' }]; }],
    ['local scope cannot reach descendant', s => { s.bundles[0].grants = [{ permission: 'workitem.verify', scope: 'unit' }]; }],
    ['wildcard grants nothing', s => { s.bundles[0].grants = [{ permission: '*', scope: 'subtree' }]; }],
    ['archived target', s => { s.units[1].status = 'archived'; }],
    ['archived ancestor', s => { s.units[0].status = 'archived'; }],
    ['cross-organization ancestor', s => { s.units[0].organizationId = 'org-b'; }],
    ['missing ancestor', s => { s.units[1].parentId = 'missing'; }],
    ['cyclic hierarchy', s => { s.units[0].parentId = 'local'; }],
    ['duplicate unit', s => { s.units = [...s.units, { ...s.units[1] }]; }],
    ['duplicate membership', s => { s.memberships = [...s.memberships, { ...s.memberships[0] }]; }],
    ['duplicate position', s => { s.positions = [...s.positions, { ...s.positions[0] }]; }],
    ['duplicate bundle version', s => { s.bundles = [...s.bundles, { ...s.bundles[0] }]; }],
  ];
  it.each(invalidStates)('denies %s', (_name, change) => {
    const state = fixture();
    change(state);
    expect(evaluateScopedAccess(state, 'workitem.verify', target, now).allowed).toBe(false);
  });

  it('keeps exact unit grants local while permitting that unit', () => {
    const state = fixture();
    state.bundles[0].grants = [{ permission: 'unit.read', scope: 'unit' }];
    expect(evaluateScopedAccess(state, 'unit.read', { ...target, unitId: 'root' }, now).allowed).toBe(true);
    expect(evaluateScopedAccess(state, 'unit.read', target, now).allowed).toBe(false);
  });

  it('does not turn professional membership into geographic authority or union unrelated grants', () => {
    const state = fixture();
    state.memberships = [
      { ...state.memberships[0], unitId: 'professional' },
      { ...state.memberships[0], id: 'other-membership', positionId: 'reader-position' },
    ];
    state.positions = [
      { ...state.positions[0], unitId: 'professional' },
      { ...state.positions[0], id: 'reader-position', bundleId: 'reader-bundle' },
    ];
    state.bundles = [...state.bundles, { ...state.bundles[0], id: 'reader-bundle',
      grants: [{ permission: 'unit.read', scope: 'subtree' }] }];
    expect(evaluateScopedAccess(state, 'workitem.verify', target, now).allowed).toBe(false);
    expect(evaluateScopedAccess(state, 'unit.read', target, now).allowed).toBe(true);
  });

  it.each(['completedByUserId', 'assigneeUserIds'])('prevents self-verification through %s', field => {
    const workItem = { ...target.workItem!, [field]: field === 'completedByUserId' ? 'reviewer' : ['worker', 'reviewer'] };
    expect(evaluateScopedAccess(fixture(), 'workitem.verify', { ...target, workItem }, now))
      .toEqual({ allowed: false, reason: 'independent_verifier_required' });
  });

  it('requires server-loaded verification context and a matching organization', () => {
    expect(evaluateScopedAccess(fixture(), 'workitem.verify', { ...target, workItem: undefined }, now).allowed).toBe(false);
    expect(evaluateScopedAccess(fixture(), 'unit.read', { ...target, organizationId: 'org-b' }, now).allowed).toBe(false);
    expect(evaluateScopedAccess(fixture(), 'unit.read', target, NaN).allowed).toBe(false);
  });

  it.each(['permission.grant', 'membership.create', 'identity.read', 'approval.approve', 'unknown'])
    ('will not authorize %s before its approval/disclosure contract exists', operation => {
      const state = fixture();
      state.bundles[0].grants = [{ permission: operation, scope: 'subtree' }];
      expect(evaluateScopedAccess(state, operation, target, now))
        .toEqual({ allowed: false, reason: 'unsupported_operation' });
    });

  it('keeps mobile mutations closed until action-bound native assurance is integrated', () => {
    const state = fixture();
    state.session.kind = 'mobile';
    expect(evaluateScopedAccess(state, 'unit.read', target, now).allowed).toBe(true);
    expect(evaluateScopedAccess(state, 'workitem.create', target, now).allowed).toBe(false);
    expect(evaluateScopedAccess(state, 'workitem.verify', target, now).allowed).toBe(false);
  });

  it('re-evaluates revocation and expiry instead of caching a previous grant', () => {
    const state = fixture();
    expect(evaluateScopedAccess(state, 'workitem.verify', target, now).allowed).toBe(true);
    state.memberships[0].validUntil = now + 1;
    expect(evaluateScopedAccess(state, 'workitem.verify', target, now + 1).allowed).toBe(false);
    state.memberships[0].validUntil = null;
    state.bundles[0].status = 'revoked';
    expect(evaluateScopedAccess(state, 'workitem.verify', target, now).allowed).toBe(false);
  });
});
