# Web account security response

Migrations 55–56 add a technical **Web account protection** panel at `/platform/accounts`. This is credential containment for organizational web accounts, separate from account activation and organizational governance. It never changes `is_active`, lockout, member status, memberships, positions, permissions, email, password or MFA. A regional membership suspension remains scoped to that membership; only a separately authorized technical response can impose this global web hold.

## Authority and supported accounts

The existing current technical-console session/grant check is mandatory. The separate capabilities are `platform.accounts.read`, `.hold` and `.release`. They are granted only through explicit operator installation, never automatically by migration or a role name. The operator bootstrap adds read/hold, the reviewer adds read/release; grant expiry, revocation and existing credentials are preserved. Release cannot be performed by the original hold issuer even if that issuer later acquires both capabilities.

This development slice accepts a new hold only when the account has an established, currently eligible personal recovery path. Technical/unclassified/bootstrap accounts and accounts with provisioned MFA are excluded from the action. In particular, existing Quick Login fixtures with pending MFA secrets cannot be stranded by this panel. Governed technical-account, lost-contact and MFA recovery remain separate gates. The account list explains unavailable actions rather than providing an unsafe recovery override.

Authorized list responses contain only opaque account/hold references, creation/hold timestamps, active/hold state, reason category, whether the operator issued the hold, and whether the password changed after the hold. No names, emails, memberships, private activity, credentials or fingerprints are disclosed. Lists use bounded 25-row UUID pagination, state filtering and optional exact account-reference lookup. The existing web-session view supplies a **Protect account** link only when the reader also has the account-read capability; technical sessions never expose an organizational account reference.

## Hold and recovery

`POST /api/v1/admin/platform/accounts/hold` accepts only account ID, request UUID and a bounded security reason. Origin/CSRF, explicit UI intent and actual current-password confirmation are required. SQL locks the target account, verifies current technical authority, records the hold and credential fingerprint, revokes every web session/step-up, revokes unused recovery and email-change requests, cancels queued/retry messages and purges their encrypted tokens. Required minimal audit and post-audit checks share the transaction. Any audit/authority/state failure rolls it back.

Held accounts cannot authenticate or create a new web session. Login rechecks the hold after audit; session authentication also checks it. A private session trigger rejects inserts and explicit revival/reassignment to a held account, including stale repeatable-read writers. Ordinary last-seen/idle refresh does not invoke that trigger. Hold changes write the account tuple to serialize snapshot writers. Deadlock retries remain limited to transactional database work, without repeating external delivery.

The owner can request a **new** password-recovery link through the previously established contact while held. The operator cannot choose the destination, see the token or set a password. The ordinary recovery rules, factor restrictions, expiry and audit still apply. Existing old proof links remain invalid. Changing the password does not remove the hold or log the owner in.

## Independent release

`POST .../platform/accounts/release` accepts the exact immutable hold ID and request UUID. Another currently authorized technical manager must confirm with their own password. The owner's password must have changed since that hold, proven by both the existing password-change timestamp and a changed credential fingerprint. An inactive account is not reactivated by releasing a hold; existing lockout, membership and MFA restrictions remain intact.

Release records the independent actor and timestamp. It never revives sessions or grants authority; normal sign-in is required. Actor/request-key receipts bind the original payload, and stale hold/release retries cannot alter a replacement hold. Unknown browser outcomes clear passwords, refresh state and never automatically replay a mutation. Table access is private; runtime has only the narrow command/check/helper functions. Technical audit exposes sanitized event names/times, not the internal payload.

## Evidence and remaining gates

`npm run test:account-security` runs disposable SQL/API scenarios for capability installation, ownership/scope boundaries, HTTP/fresh authentication, strict inputs, protected accounts, cross-region preservation, proof/session invalidation, recipient recovery, independent release, receipts/replacements, races, audit rollback/revoked authority, direct SQL and old snapshot denial, session-reference privacy, filtering and pagination. `npm run test:account-security:browser` adds the two-manager/recipient journey, native dialog keyboard/focus and language/theme/viewport checks. See STATUS for the actually executed outcomes.

This is not complete account erasure, organizational suspension, technical-account recovery or mobile-device containment. Automatic incident notices/escalation, lost-contact/second-factor appeals, production MFA, external signed audit and release/security acceptance remain unfinished. Recovery to the previously bound contact is not a new identity-verification claim. Local tests use synthetic recipients and an injected provider; they do not establish actual inbox delivery or production readiness.
