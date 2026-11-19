# Provider policy administration

Migration 37 adds a versioned VPN/proxy policy to the technical console. This is the first editable external provider integration; it does not activate identity, PAD, Android/iOS attestation, push or mobile enrollment.

## Operator workflow

Open **System administration → Provider settings** (also reachable from **Integrations → Configure provider**). Choose no provider or IPHub, disabled/enforced mode, optional suspicious-address restriction, and a replacement API key. An empty key retains the currently approved credential; it does not restore credentials from older history. Selecting no provider clears the effective credential. Historical encrypted proposals remain in the database.

Submit with the technical operator's actual password. A separate technical reviewer confirms with their own password and approves or rejects the proposal. Changes can also be withdrawn by their proposer. Approval creates the next version; copying historical values creates a new proposal against the current version, never a silent rollback. Requests expire after 24 hours. History uses bounded cursor pagination.

Local installation is explicit:
- `npm run platform:bootstrap -- --providers` adds read/propose capabilities to the existing operator.
- `npm run platform:bootstrap -- --reviewer --providers` adds read/approve capabilities to the existing reviewer.
- Existing credentials, grant expiry and revocation are preserved. Credential guides remain ignored local files.

## Authorization and persistence

The API exposes `GET /api/v1/admin/platform/provider-policy`, `POST .../propose`, and `POST .../review`. Capabilities are `platform.providers.read`, `platform.providers.propose`, and `platform.providers.approve`, alongside the technical console access gate. Organizational roles gain no implicit authority.

Writes require Origin/CSRF, fresh password confirmation, current session/grant checks, validated payloads and transactional audit. Independent review, current proposer authority, expected-version checks and post-audit authorization are enforced in SQL. Exact retries return the same receipt; changed payloads with a reused request key conflict. Retaining a key and supplying a replacement are distinct retry inputs. Approval of enforced mode requires the actual server provider and trusted-ingress bindings.

Plain API keys never enter public projections, audit payloads or browser storage. The existing authenticated encryption service protects persisted credentials; a keyed fingerprint supports idempotency. The runtime role cannot write proposal rows directly. Its restricted policy function supplies the effective encrypted credential to the API runtime; the browser receives only its presence. Database backup and encryption-key custody remain operational responsibilities. Uncertain browser writes retain the exact request only in component memory for retry and clear visible password/key inputs.

## Runtime behavior

Default policy is version 0, no provider, disabled. No external call occurs in disabled mode or through the established local recovery route. Local recovery still requires ordinary authentication, capabilities, password confirmation and independent approval.

When enforced, login and authenticated password confirmation check the verified external address supplied by the authenticated tunnel ingress. User-supplied forwarding headers cannot select this address. Requests use only the fixed IPHub HTTPS origin, an X-Key header, no redirects, a five-second timeout and an 8 KiB response limit. The returned address must match the requested canonical address.

The adapter follows the [official IPHub API contract](https://iphub.info/api): verdict 0 allows access, verdict 1 restricts access, and verdict 2 is restricted only when the optional suspicious-address setting is enabled. Enabling this integration sends the trusted external IP address to IPHub; it sends no member profile, identity document or biometrics.

Provider failure, invalid configuration, malformed responses or a policy change during a lookup deny external authentication. Existing authenticated sessions are not retroactively revoked by this provider setting. Country/IP policy continues to govern API requests separately.

Verdicts have a process-local 60-second cache keyed by policy version and keyed address identity, bounded to 1,024 entries. At most four distinct lookups run concurrently; matching requests share a lookup. Raw addresses and credentials are not cache keys or stored verdict data. Cache state resets on process restart; this is not distributed enforcement. Provider outages do not silently downgrade to an allowed result.

## Evidence and remaining gates

`npm run test:providers` exercises disposable-database and actual HTTP authorization, encrypted persistence, independent review, retry conflicts, effective login decisions, stale policy, key replacement/clearing and audit rollback. Unit tests exercise the fixed outbound adapter with synthetic responses. `npm run test:providers:browser` adds actual Chrome editing, approval, responsive layout and language/theme journeys. No real provider credential or external IPHub acceptance is supplied by those tests.

A stored key is not proof of connectivity or credential validity. Validate a real account and vendor quota before approving enforced mode. Production ingress, MFA, external audit checkpoints, credential rotation/retention operations and independent security acceptance remain release gates.
