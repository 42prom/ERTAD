# Bounded API security monitoring

**System administration → Security monitoring** adapts the retained Shield dashboard to the active ERTAD API. It reuses the console, cards, filters, themes, authentication, technical audit authority and existing session-response workflow. It does not activate the retained external Shield service or legacy IP mutation routes.

## Observations and privacy

Each application instance observes completed `/api/v1` responses, including early rate-limit and Origin denials. Six fixed categories distinguish failed login, failed password confirmation, authentication required (401), access denied (403), rate limited (429) and server errors (5xx). Login/confirmation categories come from server-owned authentication outcomes, not URLs, request bodies or client labels. Health checks, successful responses and ordinary 404s are not incidents. A denied request is not proof of an attack: an expired session or unauthenticated login-page probe can legitimately produce a 401.

The collector stores at most sixty minute buckets, each containing only six bounded counters. A view selects the current minute plus the preceding fourteen or fifty-nine minutes and an allowlisted category. `observedSince` identifies partial coverage after startup; an empty view means no matching observations during that coverage, not a security certification. No IP, forwarded header, request ID, route, URL, body, token, session ID, account identifier or member data is retained by this collector. Reading a snapshot cannot mutate its counters.

Counters are process-local and temporary. A restart clears them; idle buckets expire on the next observation/read. They are neither a durable incident history nor a multi-replica aggregate. The separate append-only audit remains intact. The panel also shows the five latest already-sanitized technical authentication audit entries; those entries are explicitly independent of the counter period filter. Organizational authentication history is not exposed through this projection.

## Authority and failure behavior

`GET /api/v1/admin/platform/monitoring` accepts only `minutes=15|60` and a fixed `category`. It requires an active web session, `platform.read` and `platform.audit.read`, using the existing SQL technical-journal authority and transaction. The audit read, including its authentication journal projection, records `PLATFORM_AUDIT_READ`. Authority is rechecked after required audit; no asynchronous work occurs between that recheck, the synchronous counter snapshot and response serialization. Audit failure, expired/revoked authority or missing collector withholds observations instead of returning fabricated zeroes. Responses use no-store and the normal API rate limit applies. No new grant, table or migration is needed.

The client clears previous data during refresh/filter changes and errors and discards obsolete responses. The parent console refreshes on focus and every sixty seconds. Georgian/English and light/dark use the shared web primitives.

## Response boundary and remaining work

Authorized operators can open the existing audit or session review from this panel. Session termination retains its own `platform.sessions.read`/`platform.sessions.revoke` capabilities, reason, password step-up, idempotency and required audit. These navigation actions do not claim a particular session caused an aggregate count and grant no organizational authority.

The source implementation used raw IP projections, Redis `KEYS` scans and broad rate-key deletion. These are not activated. Migration 35 supplies the separately verified [network attribution and targeted rules](NETWORK_CONTROL.md); migration 36 adds [approved API/login limits](SECURITY_LIMITS.md). Raw forwarded headers remain untrusted and process-local counters are not distributed incident storage. Clearing global authentication rate limits is not a response action.

Durable alert delivery, shared multi-instance counters, external WAF integration, tested detection thresholds, incident handling and independent security assessment remain release work. Existing production MFA, signed external checkpoints, secret management and restoration gates are unchanged. This panel is operational visibility, not a claim of military certification or complete attack detection.

## Network protection update (2026-10-30)

The separately approved country/IP policy and verified loopback tunnel ingress are described in [network control](NETWORK_CONTROL.md). These controls protect external API access and remain separate from mobile identity assurance, durable alerts and production ingress. Earlier deferred-network notes describe the prior slice.
