# Identity and scoped access: first implementation boundary

Implemented locally on 2026-10-04. This is a partial checkpoint 2 delivery: policy, persisted authority and an internal audited unit-read operation. Public product routes and production startup remain disabled; the local administrator account has no organization membership or product authority.

## Retained member credential

The enrollment issuer now signs an HS256 credential with issuer `ERTAD-identity-service`, audience `ertad-member-api`, `token_use: member`, version 1, an opaque server-issued user UUID, integer issued-at/expiry timestamps and a maximum lifetime of 24 hours. The retained demographic buckets have a bounded, explicit shape; arbitrary identity or privilege fields are rejected. This token does not carry permissions or prove current membership, device integrity or session revocation.

Old untyped tokens are intentionally rejected. No member credential was imported from the source application and member enrollment remains unavailable in the active development API. The obsolete generic `/auth/session/verify` handler, which accepted unrelated signed JWTs and returned an identity hash, is removed. Native platform attestation adapters are preserved.

## Scoped policy core

`backend/src/modules/organization/accessPolicy.ts` evaluates current server-owned authority snapshots. Timestamps in this policy are UTC epoch milliseconds; JWT timestamps use seconds. The internal database adapter is `backend/src/modules/organization/readUnit.ts`; callers cannot supply a snapshot or grants through its input.

| Condition | Behavior |
|---|---|
| User/session | Active user, same session subject, recognized session class, unrevoked and unexpired session required |
| Organization/hierarchy | Same active organization; target and membership units must have valid active single-parent ancestry; duplicates, missing ancestors, cross-organization links and cycles deny access |
| Membership/position | Active membership within its validity interval, linked to an active position in the same unit and organization |
| Permission bundle | Exact current version shared by membership and position; approved bundle in the same organization; revoked/draft/stale versions grant nothing |
| Permission/scope | Explicit operation with `unit` or `subtree` scope; one membership must independently grant the whole action; no role-name or wildcard grants |
| Independent verification | Work-item completion actor and all assignees come from server records; completion actor and assignees cannot verify their own work |
| Supported operations | `unit.read`, `workitem.create`, `workitem.verify`; mobile mutations stay denied until action-bound native assurance is integrated |
| Sensitive/unknown operations | Denied, including permission changes, membership changes, identity disclosure and governance approval; their dedicated contracts are pending |

Professional membership cannot supply authority in an unrelated geographic branch. A read grant in one membership cannot combine with a verification grant outside the resource scope. Evaluation returns the membership and bundle version used, so a later transactional audit can record the actual authority without copying private identity data.

## Persisted authority and audited unit reads

Foundation migration `0003_scoped_membership.sql` adds seven tables used by the read contract: opaque member users, organizations, units, permission bundles, permission grants, positions and memberships. Tenant-owned relationships use composite organization foreign keys. A member may have an explicit unique link to an existing web account; no account is linked or granted authority automatically. No private profile, legal identity, demographic or biometric field is stored here. The existing server-side web session remains the authentication primitive; mobile revocable sessions are still separate pending work.

Units have one parent, at most one root per organization and a database-enforced acyclic hierarchy. Membership intervals must be finite and ordered. Published bundle grants cannot be edited; a change requires a new version. Approved versions can be revoked, and revoked versions cannot reopen. The runtime database role can read these tables but cannot insert, update, delete or truncate authority, map a member identity, or publish a permission bundle. A later additive migration implements the [offline development bootstrap](BOOTSTRAP.md) with two independent endorsements; it remains unarmed in the actual local database. Recurring membership/permission Approval operations and the [web review inbox](APPROVALS.md) remain pending.

`readUnitForWebSession` accepts the server-authenticated session ID/hash and a target organization/unit. It rechecks the stored session, account and explicit member link, loads the applicable membership/position/bundle records, and reads only the target and membership ancestor closure. The resulting projection contains unit ID, organization ID, parent ID, name and kind; it contains no member directory, session secret or private identity.

The read runs in a READ COMMITTED transaction. A narrowly scoped SECURITY DEFINER function acquires shared locks on existing session/account/member/organization rows without granting the runtime UPDATE privileges on identities. The function has a fixed `pg_catalog` search path, schema-qualified references and no PUBLIC execute privilege. It does not mutate authority or decide permission; the service evaluates the current policy after acquiring the locks.

Every unit/bundle/grant/position/membership write increments the organization's authority revision before validation. This serializes authority writers and conflicts with the reader's organization lock. A revocation that commits first is visible to a waiting reader; a read admitted first holds the lock through its audit and commit. Updating the revision also prevents stale REPEATABLE READ writers from validating a concurrent hierarchy against an old snapshot. Shared reads can overlap; authority writes serialize per organization. This is a correctness boundary for the initial model, not a throughput benchmark. The locking behavior follows PostgreSQL's [explicit-locking](https://www.postgresql.org/docs/17/explicit-locking.html) and [application consistency](https://www.postgresql.org/docs/15/applevel-consistency.html) guidance.

The existing strict audit writer appends `UNIT_READ` with opaque organization/unit/user/membership/bundle identifiers and the bundle version in the same transaction. No projection is returned if audit persistence fails. Session and membership expiry are checked again after waiting for the audit-chain lock; expiry rolls back the provisional event. External signed checkpoints remain a production gate.

`npm run test:scope` applies the real migration runner to an isolated random database on ERTAD's PostgreSQL and removes it afterwards. Its 29 scenarios exercise persisted authority, runtime privileges, cross-tenant constraints, immutable grants, real lock waits, both revocation orderings, expiry during audit, concurrent reparenting at READ COMMITTED/REPEATABLE READ and the shared audit chain. `npm run test:integration` includes this runner. The actual development authority tables remain empty. A later batch mounts the separately authorized membership-review API described in [APPROVALS](APPROVALS.md); the unit-read operation remains internal.

## Mobile startup

The retained authenticated poll-list read is a temporary startup probe. A successful, correctly shaped response permits the retained dashboard. Only an HTTP 401 invalidates local credentials. Network, 403, throttling, server, malformed-response and secure-storage failures keep the dashboard closed and offer a localized retry. Error text is never interpreted as authentication status. Uncertain failures preserve local credentials; concurrent retries and responses after widget disposal cannot navigate. The retry state supports narrow screens, enlarged text and both languages/themes.

This probe is not the final session-introspection or revocation contract. The active development API still denies member operations. Test injection remains non-release-only, and release startup remains blocked.

## Required before enabling a domain operation

1. Complete private-profile and member-session/enrollment contracts. The opaque member/web link and minimum organization authority schema now exist; they do not establish a verified person, profile disclosure rules or device assurance.
2. Extend the tested read boundary to actual domain mutations with resource-state and qualification checks, idempotency and appropriate concurrency controls. Commit mutation and minimal audit together. The current read integration does not implement task creation or verification persistence.
3. The first recurring membership/position grant now has independent review, a scoped web inbox and in-app decision notifications (APPROVALS.md). Extend this typed boundary to the remaining approval policies without treating administrator role names or poll results as authority. Production MFA/verified-person bootstrap, recovery and broader governance remain pending.
4. Integrate revocable member sessions, recovery and action-bound native evidence; adapt both clients to the same versioned API contract. P2 provider/trust, private biometric-reference decisions and physical-device gates remain unresolved.

The policy/credential tests and 29 database scenarios establish the boundaries described above. They do not establish completed enrollment, governance approvals, task mutation acceptance, production security or device acceptance.
