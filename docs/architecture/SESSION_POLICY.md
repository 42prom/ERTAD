# Approved web-session policy

Migration 34 adds a bounded technical configuration workflow under **System administration → Session policy**. It manages real browser-session creation; it does not activate mobile authentication, remote providers, Shield, organizational privileges or production.

## Authority and review

`platform.read` and `platform.policy.read` permit viewing the effective policy and a paginated request/version history. `platform.policy.propose` permits proposing and withdrawing one's requests. `platform.policy.approve` permits approving or rejecting another technical account's request. An account with both capabilities still cannot approve or reject its own request. Technical accounts remain permanently separate from organization memberships.

Mutations require the current authenticated session, Origin/CSRF and password step-up. Proposal and reviewer authority are checked at approval and again after required transactional audit. Expired/revoked/locked authority, expired requests, stale expected versions and missing audit fail closed. A proposal expires after 24 hours. Withdrawal remains possible for a pending expired/stale request; it cannot withdraw an approved version.

## Supported values and runtime semantics

| Setting | Allowed range |
| --- | --- |
| Idle timeout | 300–3600 seconds |
| Absolute session lifetime | 900–86400 seconds |
| Concurrent active sessions per account | 1–10 |

Idle duration cannot exceed absolute lifetime. Before the first approval, version 0 displays the bounded runtime environment defaults. The migration does not silently change them. Every new login reads the latest committed approved version and pins its idle limit and absolute deadline. Cookie lifetime matches the selected absolute duration. Authentication refreshes the pinned idle limit, never beyond the absolute deadline. Pre-migration sessions preserve their existing environment-based behavior.

Approval itself does not revoke or extend existing sessions. A subsequent login enforces the then-current concurrency cap on that account's active sessions, so it can revoke older sessions above the limit. Urgent termination uses the separate reviewed [session-response controls](PLATFORM.md). No per-account identity information appears in policy history.

## Consistency and recovery

The runtime database role cannot directly read or write proposal tables. Security-definer commands enforce technical capabilities and bounded values. The runtime getter exposes only approved version/settings. The existing audit transaction lock serializes policy reviews; two requests based on the same version cannot both become current. Required audit and the policy update commit together.

Password step-up locks the current live session before the account, matching technical read ordering, and rechecks session expiry after password verification. Step-up and session creation reuse bounded retries for database deadlocks whose transaction was rolled back; password/MFA checks, failed-attempt counters and required audit are rerun atomically. This does not retry external effects or uncertain commits.

Proposal request IDs bind proposer, expected version, all values and reason. Review IDs bind reviewer, target and decision. Identical retries return the existing receipt without a second audit/mutation; conflicting reuse fails. Current session/permissions/step-up are still required for retries. Approval receipts additionally require current proposer authority and an unexpired review deadline; after that deadline, inspect the authorized history instead of relying on another approval retry.

Approved values are immutable through the application. “Propose these values” copies a historical approved configuration into a new proposal against the current version. Restoration requires another independent approval and creates a new version. No destructive rollback or arbitrary configuration editor is provided.

## Local operation

After applying migrations, `npm run platform:bootstrap -- --policy` explicitly adds read/propose capability to the existing active technical account without resetting its password or extending authority. `npm run platform:bootstrap -- --reviewer` separately creates an expiring technical reviewer with read/approve authority and no proposal or organization capability. Reruns preserve existing accounts and never revive expired/revoked grants. Reviewer credentials are written only to ignored `.local/PLATFORM_REVIEWER_ACCESS.md`; sign in through the normal email/password form in a separate browser profile. The original seven quick-login entries stay unchanged.

Production still requires mandatory web MFA, approved operator enrollment, external signed audit checkpoints and the other release gates. Local two-account testing demonstrates approval separation, not independent real-person enrollment or a security audit.
