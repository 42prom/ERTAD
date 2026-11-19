# Security limits

The technical console exposes versioned API/authentication budgets with separate `platform.limits.read`, `platform.limits.propose` and `platform.limits.approve` permissions. Organizational roles confer none of these capabilities. Explicit local bootstrap upgrades preserve passwords, grant expiry and revocation; reviewer and operator remain separate.

| Setting | Default | Allowed | Enforcement |
|---|---:|---:|---|
| API requests per address per minute | 120 | 60?600 | All API requests, including failed authentication |
| Failed attempts | 5 | 3?10 | Failed logins per address in a fixed 15-minute window; consecutive failed login/password confirmation attempts per account |
| Account lockout in minutes | 15 | 5?60 | Persistent account lockout after the failure threshold |

A proposal expires after 24 hours and requires fresh password confirmation, Origin/CSRF checks and independent approval. Requests bind an idempotency key to immutable values and a base version. Current proposer/reviewer authority, version and expiry are checked again after transactional audit. History is cursor-bounded. Reusing historical values creates a new proposal; it does not rewrite an approved version. Migration 36 grants runtime execute-only access to the command and approved-value reader, not the proposal table.

The running local API reads validated approved values on every API request. Database failure or invalid values return 503; health remains separate. A request already in progress uses its policy snapshot. Changing a policy does not erase counters or shorten an existing account lockout. Successful authentication clears the account's consecutive failure count. Successful login responses do not consume the address failure budget; simultaneous unfinished login attempts temporarily do.

Verified Cloudflare ingress produces a keyed client fingerprint. IPv6 rate keys group /56 networks to resist address rotation; IP block rules keep their separate exact-address fingerprints. Untrusted headers cannot set limiter keys. Direct local requests share the socket-peer budget. An outer fixed 1,200 requests/minute per socket-peer budget bounds work before network attribution and policy reads. Through the tunnel this is a shared ingress ceiling, not a per-user capacity guarantee.

Address counters are per API process and reset on restart. Account failures and lockouts persist in PostgreSQL. Shared multi-instance counters, edge capacity acceptance, VPN/provider intelligence, enrollment-specific budgets and mobile-device assurance remain separate work. There is no runtime counter-reset endpoint or role exemption.

Run `npm run test:security-limits` for disposable-database/HTTP enforcement and `npm run test:security-limits:browser` for real Chrome operator/reviewer flows. Browser tests never approve policies against the live developer database.
