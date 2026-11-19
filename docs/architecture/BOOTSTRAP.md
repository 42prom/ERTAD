# Development governance bootstrap

Implemented on 2026-10-04 as an offline development/test installer. It is not production bootstrap, the recurring Approval engine, or the web review inbox. Production startup remains disabled; production MFA, verified-person enrollment and provider/device acceptance are still release gates.

## Ceremony and boundaries

Migration `0004_governance_bootstrap.sql` creates an installation-wide latch and append-only event history. It does not arm the installer, create accounts or grant permissions. The API role receives no access to these tables, and its authority tables remain read-only.

The installer requires an owner connection to ERTAD's local database and explicit `ERTAD_BOOTSTRAP_MODE=true` in a separate process. The API host rejects that flag so it cannot expose or unexpectedly re-enable bootstrap. An eligible installation has no organization or member identity yet; existing authenticated web accounts are allowed.

An owner arms an immutable plan naming two different existing web accounts, an organization name and an operational reason. The plan expires after ten minutes. The permissions come from a fixed installer definition, not caller-supplied role names or an editable permission list.

1. The nominated proposer uses their opaque web session after fresh password step-up. Their endorsement authorizes the **other** account's initial membership. No organization, member or grant exists yet.
2. The nominated confirmer independently endorses the proposer's membership or rejects the ceremony. The proposer cannot confirm or reject their own proposal; an unrelated superadmin account cannot substitute for a nominated principal.
3. Confirmation atomically creates one organization/root, two opaque members linked to those accounts, a fixed approved bundle, one position and both scoped memberships. Each membership has an endorsement from the other principal. The bundle was defined by the installer, not authored by either approver.

The initial bundle contains `unit.read`, `workitem.create`, `workitem.verify`, `membership.propose` and `membership.approve` with subtree scope. These are explicit records, not a permanent root bypass. They do not reveal protected identity or override independent approval. Only the existing internal unit-read operation is currently integrated; task/membership mutation handlers and their web UI remain unavailable. The generic scoped policy still denies unsupported operations.

Both accounts must be active and unlocked; both stored sessions and step-up deadlines are revalidated through confirmation. The proposer must use the same live session for an exact retry. A revoked or missing original session invalidates the pending endorsement. Standard session cleanup remains possible because history stores session IDs without retaining their rows or secrets.

The ceremony is serialized by an installation lock. Eligibility checks lock member/organization tables against concurrent creation. The immutable plan, both grants, event history and shared audit commit together. A deadline crossed while waiting for audit rolls back the whole activation. An exact same-session decision retry returns the original result; it does not repeat grants or create additional events.

Completed/rejected ceremonies cannot reopen or be erased through the installer. Expired plans cannot silently reset. Recovery from an expired/rejected setup is intentionally not implemented in this initial installer; do not delete the latch or edit migration checksums to work around it. A reviewed recovery procedure is required before operational rollout. Database-owner/superuser compromise remains outside what application-level approvals can prevent.

## Local operation

Do not run this merely to populate demonstration data. It requires two nominated accounts with independently authenticated sessions. The ERTAD development database has not been armed or initialized by this implementation; the existing local login account and its credentials are unchanged.

Commands are available as `npm run governance:bootstrap -- <action> <value>` in a dedicated offline process with development mode and the explicit bootstrap flag. The flag is never written into `.env` by the installer.

- `arm .local/<plan>.json`: read an ignored JSON plan containing only `id` (a UUID), `proposerAccountId`, `confirmerAccountId`, `organizationName` and `reason`. The file must resolve inside `.local`. It contains no passwords, session tokens or biometric data.
- `propose <bootstrap-id>`: read the proposer's opaque session token from stdin after password step-up.
- `confirm <bootstrap-id>` or `reject <bootstrap-id>`: read the confirmer's opaque session token from stdin after their own password step-up.

Never put tokens on the command line, in a committed plan, logs, screenshots or shell history. The installer returns only ceremony ID, status and the resulting organization ID. It creates no login accounts, resets no passwords, changes no `.env` values and prints no token. Remove the bootstrap flag from the caller's environment afterwards; ordinary API startup rejects it.

`npm run test:bootstrap` uses separate random `ertad_bootstrap_test_*` databases and synthetic accounts. Twenty scenarios cover explicit mode/owner checks, eligibility, independence, state immutability, revocation, step-up expiry, audit rollback at each phase, expiry during an actual audit lock wait, concurrent confirmations, existing scoped reads, terminal rejection/non-reuse, shared audit-chain integrity and normal session cleanup. The databases are removed afterwards. These tests do not prove distinct real-world people, production MFA, a completed general Approval engine or hosted/device acceptance.
