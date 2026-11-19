# Technical platform console

The adapted Shield dashboard now adds [bounded API security monitoring](MONITORING.md) under the existing technical audit capability, with explicit process-local coverage and links to the separately authorized session-response workflow. External Shield/network mutation APIs remain inactive.

Migrations 31–34 implement the technical administration slices under ADR-022. **System administration** has a current dependency overview, sanitized technical audit browser, explicitly authorized web-session response, [integration inventory/diagnostics](INTEGRATIONS.md) and [independently approved session policy](SESSION_POLICY.md). It is separate from the organizational council, regional and group workflows. The shared web application, password/session implementation, required audit writer, sidebar, cards and controls are reused. Legacy security settings, account-management, Shield and integration mutation APIs remain inactive.

## Authority and account separation

`platform_accounts` is a permanent technical account classification linked to an existing web account. Its explicitly persisted permissions are `platform.read` and `platform.audit.read`, with a start, expiry and optional revocation. Audit access also requires overview access. The ordinary role label provides no technical permission: the local installer deliberately creates an `observer` web account with separate technical grants. Council accounts do not inherit these grants.

Technical accounts cannot be linked to `member_users`, even after their technical grants expire or are revoked. An existing organizational web account cannot become technical. Both insertion directions serialize on the web account row; changing an existing member link is checked too. Deleting the classification or changing its identity is rejected; access is removed through expiry/revocation instead. There is no runtime grant/renew/classify API and no runtime table grant. Database/server owners remain outside this application authorization boundary.

The command validates the actual server session and active/unlocked account, takes locks on the current classification, enforces the required capabilities, writes a mandatory audit event and rereads before disclosure. `clock_timestamp()` checks catch expiry during audit. A failed audit returns no initial data. Overview probes run only after authorization, have bounded response waits and are followed by another current authority check. Dependency failures produce only `unavailable`, never connection strings or exception details. Probe timeout bounds the response wait, not arbitrary cancellation of an underlying driver operation; existing dependency clients retain their own timeouts.

## Displayed information

- Database, cache and private storage readiness reuse the application's actual readiness checks.
- Applied migration count, the operator's own active-session count, grant expiry and observation time are shown. No organization/member statistics are included.
- Production startup remains blocked. Development MFA is disabled by the existing user-approved policy; mandatory production MFA and external signed audit checkpoints are shown as outstanding release gates. A healthy service does not prove secure configuration or a verified audit chain.
- The technical journal projects only event ID, time and an allowlisted event type for classified technical accounts. It excludes payloads, actor IDs, account emails, IPs, user agents, secrets and organizational events. Login failures without a verified technical account are intentionally omitted, so this is not a complete intrusion-monitoring feed.
- The journal filters technical access versus technical authentication and uses bounded 25-row keyset pages. New audit writes do not shift older cursor pages. A partial event index supports this projection. No export or raw ledger endpoint is enabled.

The browser has loading/error/denied states, clears old projections before refresh, ignores late responses, and refreshes on focus and every 60 seconds. The server still authorizes every request. Technical accounts land on `/platform`; organizational menus/inbox probes are not loaded for them. Current read-only capabilities authorize neither configuration changes nor another person's session termination.

## Local operation

Apply `npm run db:migrate`, then explicitly run `npm run platform:bootstrap` once. The installer creates an independent local technical account with a random password and 90-day grants, without organizational membership. Credentials are saved only in ignored `.local/platform-access.json` and `.local/PLATFORM_ACCESS.md`. The command refuses to replace an existing account and reruns preserve passwords and grant expiry/revocation. It does not alter the existing six quick-login accounts or `.env` flags. This local installer is not production bootstrap or an HTTP self-grant mechanism.

Sign in through the normal local login form using the ignored guide; the console then opens automatically. Existing council/regional quick-login buttons remain available for organization workflows. The API, web application and configured development tunnel retain their existing lifecycle commands.

October 28 quick-login extension: with `ERTAD_WEB_DEMO=true`, a valid optional `.local/platform-access.json` adds **Technical administrator** beside the six existing buttons. It reuses the same loopback/configured-development-tunnel, Origin, password, session and audit checks. The response contains account labels only, never the stored password. A missing or malformed technical fixture leaves the original six accounts available. A disabled/mismatched account cannot use the shortcut. Authentication does not renew/revive technical grants: an expired/revoked operator may authenticate but cannot access protected panels. Technical password step-up remains the ordinary `/auth/step-up` flow; the organization demo step-up shortcut does not apply to this account. Tests explicitly inject synthetic technical fixtures and never read the developer's local technical credentials.

The [mobile control adaptation inventory](MOBILE_CONTROL.md) records retained source capabilities, remaining integration boundaries and the next delivery order.

`npm run test:platform` exercises isolated database and HTTP boundaries; `npm run test:platform:browser` adds a synthetic localhost Chrome journey. See STATUS for actual checks and activation evidence.

## Web-session response

Migration 32 adds `platform.sessions.read` and `platform.sessions.revoke`. Both require active `platform.read`; revocation also requires session-read authority and current password step-up. Role names do not authorize either operation. The scope is browser administrator sessions only, across technical, organizational and otherwise unclassified web accounts. Member mobile credentials, hardware attestation and push tokens are separate contracts.

`GET /api/v1/admin/platform/sessions` returns at most 25 active sessions, with an opaque UUID cursor and account-class filter. It projects session reference, class, current-session marker, creation/last-request times and effective expiry. It does not disclose names, account IDs, email, IP, user-agent, organizational membership, token hashes or CSRF secrets. Disabled/locked accounts and expired/revoked sessions are excluded. The list is a request-time snapshot, not a presence tracker.

`POST /api/v1/admin/platform/sessions/revoke` requires Origin, CSRF, explicit grants and fresh password authentication. The body is strictly `{sessionId, requestId, reason}`; reasons are `suspected_compromise`, `operator_request` and `session_hygiene`. The confirmation dialog requires the operator's password and a reason; neither is persisted in browser storage. Current-session revocation is rejected, with ordinary logout remaining the appropriate action. One response invalidates the selected session; it does not disable an account, change membership/points, prevent a new login or cancel a transaction that already completed.

Authority/session/grant locks, the existing audit-chain lock and a target-row lock serialize responses. Revocation, bounded audit metadata and a receipt commit in one transaction; authorization and step-up are checked again after audit. Failure rolls everything back. Exact retries return the original receipt, including after normal session cleanup; changed payload with the same actor/request key conflicts. A different response to an already inactive session conflicts. Fresh authority remains required even to retrieve a retry receipt. Receipt rows omit identity/credentials and are inaccessible directly to the runtime role. The sanitized technical journal shows the response event/time/reference without raw target/reason payloads.

The migration itself grants no additional authority. For the existing local technical account, run `npm run platform:bootstrap -- --sessions` explicitly. This adds the two capabilities only to an active unrevoked grant, preserves credentials and expiry, audits the change once and leaves an expired/revoked grant unchanged. A plain installer rerun still preserves existing grants. No HTTP self-grant/renew endpoint exists.

Next: narrowly scoped integration/configuration changes with independent approval where required, then bounded Shield response and the mobile identity/device lifecycle. No impersonation, organizational grants, privacy bypass, disabling authorization/audit or unrestricted settings editor is planned. Production MFA/bootstrap, external audit checkpoints, account recovery, monitoring and independent security/performance validation remain release gates.

## Network protection update (2026-10-30)

The separately approved country/IP policy and verified loopback tunnel ingress are described in [network control](NETWORK_CONTROL.md). These controls protect external API access and remain separate from mobile identity assurance, durable alerts and production ingress. Earlier deferred-network notes describe the prior slice.
