# Network access control

The technical console's **Network protection** view controls external `/api/v1` requests. It does not grant organizational or identity authority. Static web assets and health endpoints remain reachable; passwords, session validation, Origin/CSRF, capabilities and audit still govern application access.

## Trust boundary

Development runs the API and Vite on loopback. The named Cloudflare tunnel forwards to a separate loopback ingress in the same Vite process (default 15174); direct local web access stays on 15173. Only that listener marks requests using a private in-process symbol. The API proxy strips incoming Cloudflare, forwarded and ERTAD attribution headers, then authenticates its loopback hop using an independent private key. Plain web requests cannot manufacture the listener marker through headers.

The ingress consumes Cloudflare's `CF-Connecting-IP` and `CF-IPCountry`, rejects Worker and Pseudo IPv4 metadata, and does not trust arbitrary `X-Forwarded-For`. Country approval stays disabled until an anonymous external baseline/forged-header probe verifies the configured route. Cloudflare visitor location headers must be enabled for that route. These are development controls, not a production ingress design: local machine processes, the tunnel configuration and Cloudflare account are trusted operator boundaries. Do not expose any listener directly to the Internet or route an untrusted proxy to the ingress.

References: [Cloudflare headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/) and [Tunnel origin configuration](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/).

## Rules and approvals

Migration 35 adds a versioned policy and separate `platform.network.read`, `platform.network.propose`, `platform.network.approve` capabilities. The technical operator can propose; a separate technical reviewer approves or rejects. Even an account holding both capabilities cannot approve its own proposal. Password confirmation, CSRF, current authority, request-key idempotency and transactional audit are required. Authority is rechecked after audit; stale/racing approvals cannot create two effective versions. Proposals expire after 24 hours. Restoration creates a new proposal and requires another review.

Country modes are off, allow-list-only, and deny-list. Codes use two uppercase characters (Cloudflare's T1 is also accepted); unknown XX is denied whenever country filtering is active. Turning the country filter off does not remove IP blocks. At most 50 temporary IP blocks and 20 temporary country exceptions are accepted, with deadlines no more than 24 hours after submission. **An active IP block wins over an exception.** An exception bypasses only country filtering. Expired entries remain visible in immutable history but cease enforcing; copying a prior policy omits expired entries.

Canonical IPv4/IPv6 addresses are transformed with keyed HMAC-SHA256. Rules store only fingerprints and expiry, and audit stores minimal proposal/status metadata. Raw addresses exist transiently to evaluate requests or prepare a target. They are not persisted in rules or application logs. This is pseudonymization, not anonymization. Key rotation needs a reviewed replacement policy; do not silently rotate the address key or assume old fingerprints remain effective.

Every external API request reads current committed policy; database/configuration failure denies access. Approving a policy that blocks the reviewing external connection is denied. Direct local access provides recovery from country/IP lockout **only after normal authentication and separate approval**; it never bypasses permissions or audit. No country or IP is blocked by default.

## Local operation

1. Stop only this checkout: `npm run dev:stop`.
2. Apply additive migrations: `npm run db:migrate`.
3. Explicitly upgrade existing accounts: `npm run platform:bootstrap -- --network` and `npm run platform:bootstrap -- --reviewer --network`. Passwords, grant expiry and revoked state are preserved. Reviewer credentials remain in ignored `.local/PLATFORM_REVIEWER_ACCESS.md`.
4. Run `npm run network:setup`. It checks the ingress port, generates only missing independent keys, preserves the original ignored tunnel config in `.local/cloudflared-before-network.yml`, and updates only the ERTAD route.
5. Run `npm run dev`, then `npm run network:verify`. This sends anonymous requests only. On success restart development to load the verified-country gate. On failure leave country approval gated and inspect Cloudflare location headers/Worker/Pseudo IPv4 configuration; do not manually claim verification.
6. Use System administration → Network protection. Keep localhost access available while reviewing external access rules.

For recovery, log in locally with the normal operator/reviewer credentials and approve a replacement policy. Do not reset credentials, delete history or disable authentication. Back up both the database and private address-key configuration; never include keys in Git. Restarting the application does not reset the approved policy.

## Verification and limits

`npm run test:network` uses a disposable database and synthetic documentation IPs. It covers actual ingress separation/header stripping, IP canonicalization, country/IP priority, independent approval, CSRF/password gates, strict bounds, retries, version races, proposer revocation, post-audit expiry, rollback and denied direct runtime writes. `npm run test:network:browser` also exercises the two-account UI and responsive language/theme variants.

Migration 36 adds [approved per-client API/login limits](SECURITY_LIMITS.md) after verified attribution, including IPv6 /56 grouping. A fixed outer socket-peer ceiling still bounds work before attribution. Counters remain per process; this is not a distributed limiter, DDoS service, device-attestation system or independent security audit. Provider/device enrollment, durable alerts, signed external audit checkpoints, production MFA and production ingress configuration remain separate release work.
