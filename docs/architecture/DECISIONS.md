# Foundation decisions

## ADR-001 — Isolated repository and incremental reuse
Accepted: ERTAD has its own repository and data volumes. DTG remains read-only reference with dirty changes preserved. Reuse reviewed framework/patterns/components incrementally; do not import national-election schema or production data. Initial user authorization covers a runnable local foundation; full domain implementation waits for its audit and security gates.

## ADR-002 — Host development, optional container apps
Accepted: API (13000) and Vite (15173) run locally with hot reload. Compose defaults to PostgreSQL (15432), Redis (16379) and S3 (19000). All bindings are loopback. Dedicated bridge network avoids sharing service DNS/volumes with other projects; outbound traffic is not blocked by this bridge. An internal-only Docker network was unsuitable for host access on this Docker Desktop setup. Optional `apps` profile supplies parity checks/CI. No Kubernetes, message broker or domain microservices.

## ADR-003 — Separate semantic visual families
Accepted: web follows reviewed DTG sidebar/slate/sky conventions. Mobile retains a separate night family; provisional day design follows navy/blue direction. Shared semantic tokens generate CSS and Dart, while interaction semantics remain consistent. Theme/locale preferences work locally without a backend. Do not claim Flutter/device validation from a browser palette sample.

## ADR-004 — Production disabled until security gates
Accepted: public foundation contains only operational health and a labelled component gallery. Product APIs deny access. Startup in production/unknown modes fails. Implement real identity, bootstrap/MFA, scoped permissions, data protection and release gates before enabling production. A non-production build is not authentication bypass.

## ADR-005 — Local S3 implementation
Accepted for local development: SeaweedFS single-node `mini`, separate volume, credentials and private initial attachment bucket. No real attachments or biometric data are loaded. Legacy MinIO registry pulls returned 401 and its official community repository is archived; it is not selected as a new dependency. Production storage/provider, retention, encryption, backups and independent audit-checkpoint destination remain separate reviewed choices. Sources checked 2026-10-01: [MinIO status](https://github.com/minio/minio), [SeaweedFS quickstart](https://github.com/seaweedfs/seaweedfs#quick-start).

## ADR-006 — Phased scope and privacy baseline
Accepted: V1 core, V1.5 network, V2 gamification. New profiles Private; no unauthorized membership enumeration; minimum anonymous electorate 10; rare-attribute threshold k>=10; external signed audit checkpoints mandatory. Adults-only product default pending concrete enrollment policy. Public discovery is constrained by organization and context. No XP/referral/money authority.

## ADR-007 — Local agent workspace stays private
Accepted: local prompts, agent instructions, skill copies and working audit reports are excluded from Git and Docker contexts. Hooks and CI scan eligible/tracked filenames to catch accidental forced additions. Checked-in code, tests, README, ADRs and operational architecture are independent of private working instructions. This guard is not a complete content/secret scanner; content review remains required.

Runtime sources checked: [Node release lifecycle](https://nodejs.org/en/about/previous-releases), [Compose dependency health ordering](https://docs.docker.com/compose/how-tos/startup-order/). Lockfiles and pinned image digests define actual builds; sources do not substitute for runtime checks.

## ADR-008 — Actual DTG application reuse with preserved local changes

Accepted for migration planning, 2026-10-01: DTG's local working tree is the implementation source, including its uncommitted security improvements and tests. Preserve source revision and file hashes, transfer complete reviewed flows into ERTAD and retain isolated ERTAD infrastructure. The web target is at least 90% of applicable original journeys/structure, tracked with explicit exclusions rather than an unmeasured code-percentage claim. No DTG source modification, whole-schema import, secrets or production-data transfer is implied. P1 migrates presentation; P4 connects authenticated flows after the Identity and Authorization gates. See the [transfer map and delivery sequence](MIGRATION.md).

## ADR-009 — Zero Trust is a migration acceptance requirement

Accepted design requirement, 2026-10-01: preserve native integrity adapters together with their server validators and regression tests. Every protected request independently requires valid session/assurance and applicable permission/scope. Client verification flags, network location, device attestation and administrator rank cannot substitute for authorization. Generalize action binding without creating a participant-to-ballot correlation path. Provider outages and unsupported devices must not create authentication bypasses; offline UI distinguishes unconfirmed state. This is not a claim that every current DTG path already meets the target. See the [boundary and negative-test matrix](MIGRATION.md#zero-trust-contract).

## ADR-010 — Identity continuity reference has an explicit activation gate

Proposed, 2026-10-01: support new-device/recovery identity continuity with renewed document authenticity and PAD/face checks, stable verified-person matching and, if justified, a protected biometric reference. Reference format, provider/model, retention/deletion, key custody, matching and manual-review policy must be resolved before storage is enabled. No indefinite raw media retention, biometric-only account takeover path or automatic replacement on mismatch. Routine same-device login and re-proofing have separate contracts. See the [recovery design](MIGRATION.md#identity-continuity-biometric-reference-and-recovery).
