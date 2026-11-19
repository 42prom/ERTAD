# ERTAD foundation architecture

Status: initial architecture, 2026-10-01. This document describes decisions and future acceptance gates; it does not claim those domain features are implemented.

Current delivery priority (2026-10-07): web management for council and regional administrators, with a synthetic six-account local demo under ADR-017. Mobile follows later for group administrators and members only. Current scope and working evidence are in [STATUS](../STATUS.md); initial phase ordering below is an acceptance inventory, not a blocker on the authorized web-first development.

The detailed [source application migration plan](MIGRATION.md) defines actual source-module reuse, preservation of local changes/tests, Zero Trust acceptance and rollback. Complete application source is transferred first, then adapted through these gates. Local web login is available under ADR-012/013; authenticated domain journeys still depend on their P2/P3 security contracts. The 2026-10-03 [execution checkpoints](MIGRATION.md#execution-checkpoints) prioritize one complete journey under ADR-015. See [verified status](../STATUS.md) for current execution evidence.

## Scope and runtime

Migration 37 adds [reviewed provider configuration](PROVIDER_POLICY.md) to the technical console, with a real VPN/proxy authentication consumer. This does not activate mobile identity/device enrollment; the ordered technical adaptation and remaining gates are in [MOBILE_CONTROL](MOBILE_CONTROL.md).

The November 5 mobile authentication direction extends the earlier document-only enrollment target: an explicitly authorized technical operator selects one Google-account, document-and-face, or hybrid profile. Hybrid is recommended: Google enables authorized reading, and valid document-and-face identity proof is required before participation. Existing valid proof is reused without re-enrollment on every vote. All profiles retain device/session and authorization protections; Google alone does not establish verified document identity or person uniqueness. This is a design decision, not active runtime behavior. [ADR-023](DECISIONS.md#adr-023---operator-selected-mobile-authentication) and the [mobile policy contract](MOBILE_CONTROL.md#operator-selected-mobile-authentication-2026-11-05) govern assurance, account continuity and acceptance before implementation.

Migration 28 connects individual manual recognition to verified task Activity through the existing collective approval and Contribution ledger. [Verified-work recognition](WORK_RECOGNITION.md) defines scoped recipient selection, source deduplication, current policy and private history. Role-specific reward combinations and the broader unified contribution view remain separate work.

Migration 29 adds [task amendments](WORK_EDITING.md): scoped open-task editing with reasons, before/after history, bounded allocation/deadline changes and preserved verified Activity/reward terms. This starts the module lifecycle work; task archive/deletion, event rescheduling and reviewed group lifecycle remain separate slices.

Migration 30 adds the [scoped member directory](MEMBERS.md): explicit discovery permission, shared organizational labels, membership filters and source-authorized points/task participation. Its member card links existing appointment and recognition workflows. Platform technical administration is separate under ADR-022 and does not inherit organizational authority.

Migrations 31–33 implement the [technical platform console](PLATFORM.md): expiring explicit technical capabilities, account separation, dependency readiness, sanitized journal, password-confirmed web-session response and [integration inventory/diagnostics](INTEGRATIONS.md). Migrations 34–36 add independently approved [session policy](SESSION_POLICY.md), [network controls](NETWORK_CONTROL.md) and enforced [security limits](SECURITY_LIMITS.md). Provider configuration and mobile credential/device lifecycle remain subsequent work; organizational authority is excluded.

The October 22 [mobilization decision](MOBILIZATION.md) refines delivery: simple voluntary participation and practical-support tasks, optional operational detail and configurable recognition through the existing Contribution ledger. Events provide shared scheduling and grouping while reusing Work. This changes implementation priority without removing hierarchy, privacy, independent verification or the other V1 requirements.

Migration 23 delivers the first slice: simple task forms with optional time/place, independently approved reward templates restricted by hierarchy, explicit no-reward tasks and preserved immutable offers/history. One task has one offer. Materials and hierarchical completion review are delivered in migrations 24–26. Migration 27 adds [events](EVENTS.md), scoped linked tasks and one immutable automatic reward occurrence per event/member. [STATUS](../STATUS.md) records the tested runtime boundaries.

Migrations 24–25 add [shared task links, photos and PDFs](WORK_MATERIALS.md) within existing Work scope, separate from private completion reports. File originals are reconstructed before private publication; current authority, audit, integrity and retention govern downloads. Production parser isolation and monitored cleanup remain release gates. Migration 26 adds [upper-level completion review](WORK_REVIEW.md) with pinned assignment floors and matching task/inbox controls. Migration 27 groups participation/support tasks without adding another staffing engine. Remaining V1 communication/delivery, reporting, governance and identity/privacy gates follow; mobile remains deferred.

V1: identity/enrollment/recovery/private profiles; organizations, units, memberships, permission/scope, approvals/audit; work; basic text communication/moderation; decisions; Activity, contribution points and Qualifications; promotion/sensitive access; Events, financial contribution records and permitted reporting; operational hardening. [Contribution points](CONTRIBUTION.md) are a 2026-10-05 scope extension under ADR-016, with administrator-configured participation rules and scoped manual recognition.
V1.5: referrals, subscriptions, public-figure/organization channels, QR, advanced discovery.
V2: XP, levels, recognition, optional bounded leaderboards and challenges. V1 has no dependency on these.

```mermaid
flowchart LR
  W[React / Vite management] --> A[Node / TypeScript modular monolith]
  M[Flutter member app — transferred baseline] --> A
  A --> P[(PostgreSQL)]
  A --> R[Redis — ephemeral]
  A --> S[S3-compatible private objects]
  A -. enrollment migration .-> B[Isolated biometric runtime]
```

Development: API and Vite run on the host with hot reload; Compose runs the three data dependencies. The optional `apps` profile runs API, one-shot migrations and nginx/web for CI parity. The host API exposes opt-in local administrator authentication with password, server sessions and Origin/CSRF checks; development does not require an authenticator code (ADR-013). Accepted membership reviews enforce persisted scope; legacy domain operations remain denied. The optional six-account synthetic fast-login demo is loopback-only (ADR-017). Production mode refuses startup; MFA for every web user is a production release gate.

## Module ownership and dependencies

| Owner | Entities | Dependencies |
|---|---|---|
| Identity | User, Profile, IdentityVault, Device, Session | Security audit; external document/PAD providers |
| Organization | Organization, Unit, Membership, Position, permission bundle | User opaque IDs; Approval |
| Work | WorkItem, WorkItemRole, Assignment; thin Event later | scoped authorization; Qualifications |
| Communication | Channel, Message, delivery state; Subscription in V1.5 | Membership/Assignment authorization; Moderation |
| Decisions | Decision, electorate snapshot, Participation, Ballot | membership snapshot; privacy policy |
| Activity | Activity, ContributionPoint entries/rules, Qualification; financial records later in V1 and Referral in V1.5 | verified sources, explicit award scope, no authority grant |
| Governance | Approval, versioned declarative Definition | explicit permissions; AuditEvent |
| Security | AuditEvent, external checkpoints, ModerationCase | opaque IDs; key management |

Module tables remain in one PostgreSQL database. Modules expose explicit operations, not unrestricted shared table access. Do not create empty layers or services ahead of a vertical slice. Redis is disposable and cannot be the source of votes, approvals, activity or membership truth.

The implemented Communication slices are documented in [COMMUNICATION.md](COMMUNICATION.md): unified administrative inbox, published Decision notices, private unit channels, task-linked conversations, temporary channel writing restrictions with independent appeals, and scoped moderation notices with exact-record navigation. Task conversations reuse the channel engine and require current authority in both Work and Communication; there is no second chat service or role-name access shortcut. Remaining delivery and moderation scope is tracked there and in [STATUS.md](../STATUS.md). Migration 21 connects the existing [Contribution/recognition journey](CONTRIBUTION.md#recipient-notices-and-web-acceptance) to recipient-only notices and exact private history. Migration 22 adds the first [private task report](WORK_EVIDENCE.md) slice: bounded text files, current-scope download, audited publication and expiry; richer formats and monitored physical cleanup remain release work.

ADR-015 keeps authorization/disclosure shared while preserving domain-specific state rules. A Decision approval does not replace Governance Approval for a sensitive mutation. A task completion, its Activity entry and required audit are transactional; external notifications use durable minimal delivery records only when a real feature needs them. Definitions configure supported variants without executable rules or a universal entity model. These are planned boundaries, not implemented guarantees.

## Data model constraints (planned, not migrated)

- UUID opaque internal IDs. Profile discovery IDs are random, nonsequential and distinct from primary keys. User default visibility PRIVATE. Effective disclosure is the most restrictive user, organization, field and context policy.
- Tenant-owned records use `organization_id NOT NULL`. Composite `(organization_id,id)` foreign keys prevent cross-tenant links. Tenant/status/time indexes support bounded list queries. No public enumerable membership directory.
- Unit has at most one authority parent in its organization; reject cycles transactionally. Professional affiliation never creates a second authority parent. Membership connects user, unit, versioned position and validity interval; index active membership lookup and test expiry/revocation.
- Permission bundle grants operation + scope, never a role-name shortcut. Approval stores request author, immutable payload/version, independent approver, reason, expiry and outcome. Revalidation occurs at execution; mutations of a pending payload invalidate approval.
- IdentityVault is separate from public profile and sessions. Encrypt sensitive fields with externally managed keys; normal modules receive opaque user IDs. Exact legal identifiers and biometric media never enter audit payloads.
- WorkItem parent allocations and Assignment final-slot allocation use transactions/row locks; unique assignment/application keys and payload-bound idempotency prevent duplicates. Qualification revocation is checked on acceptance/assignment.
- Activity and contribution points are append-oriented, with corrections/reversals tied to source records. Award uniqueness survives rule-version changes; caps and manual awards enforce live scope. Anonymous rewards use participation only without ballot/answer linkage. Financial/referral events and points cannot affect governance eligibility. No XP/level system is needed in V1.
- Decision snapshots eligibility when opening. Participation is unique per `(decision_id,user_id)`. Ballot contains randomized ID, decision ID, choice and coarse timestamp only: no user/device/identity/participation foreign key or reusable request correlation ID. Schema and telemetry tests must cover indirect joins. Minimum anonymous electorate is 10; organizations may raise it, never lower it. Suppress revealing small/unanimous breakdowns.
- Private profile attributes support EXACT, BUCKETED, SHARED_CONTEXT_ONLY, HIDDEN; rare attributes/context combinations are generalized at default k>=10. Exact-ID search is authorized and rate-limited; no prefix enumeration.
- Sessions distinguish mobile and privileged web. Production browser authentication needs HttpOnly/Secure/SameSite cookies, CSRF protection, MFA, expiry, step-up and revocation. ADR-013 permits password-only local development; protected domain administration still requires explicit permission/scope and applicable approval.

## Authorization matrix (policy examples, not hard-coded roles)

Every permission requires active membership plus scope. Independent approval and identity grants remain additional checks for every row.

| Position template | Permitted scope | Example operations | Explicit exclusions |
|---|---|---|---|
| Member | own/shared permitted unit | read permitted work, opt in, participate in eligible decision | directory enumeration, administrative grants |
| Team Manager | assigned team/subtree | allocate and verify team work | self-approval; protected identity by rank |
| Group Manager | group subtree | unit/member operations and delegation where granted | unrelated groups; own promotion approval |
| Regional Manager | region subtree | cross-group allocation, scoped reporting | other regions; vault access by rank |
| Professional Manager | professional unit | qualification review and professional work | geographic authority merely by profession |
| Organization Council | explicitly granted organization/subtree scope | organization policy, appointments and contribution policy | technical platform authority by rank; self-approval; protected identity by rank |
| Platform Administrator | explicitly granted, expiring technical platform scope | dependency status, sanitized technical audit, bounded API response monitoring, separately granted web-session termination, bounded integration diagnostics and independently approved session-policy versions; provider credential configuration remains planned | member directory, organizational appointments, work/Decisions/points mutations, impersonation, raw identity or message access |

Bootstrap: one-time eligible installation, explicit mode, initial administrator set, MFA, confirmation/audit, permanently disabled afterwards. No secret permanent root. Break-glass, if implemented, has reason, limited permissions, short TTL, MFA, immediate alert, audit and post-event review; privacy boundaries remain.

## Threat model and privacy inventory

| Threat | Asset / path | Planned mitigation | Residual exposure if control fails |
|---|---|---|---|
| Server compromise | runtime and keys; malicious deployment | least privilege, patching, secret separation, signed releases, incident rotation | runtime can observe decrypted requests; not protected by DB encryption alone |
| Full database copy | identity, membership graph, messages, votes | field encryption, separate keys, opaque IDs, minimized logs, unlinkable ballots | membership graph and timing metadata may remain identifying; pseudonyms are not anonymity |
| Server seizure / infrastructure administrator | disks, backups, secrets | external KMS, encrypted backups, separate access, external checkpoints | available runtime keys or simultaneous key compromise defeats confidentiality |
| Device theft/seizure | sessions, cached data | secure storage, local minimization, remote revocation, step-up | unlocked device/screens may expose permitted content |
| Legal request | membership/identity records | documented request review, minimization, retention controls | compelled disclosure limits require qualified review; no promise of immunity |
| Network blocking | service availability | explicit offline state, bounded retries, tested recovery | service may remain unreachable; no silent offline votes |
| Compromised platform admin | permission grants/identity access | permission+scope, MFA, independent approval, alerts/checkpoints | colluding approvers or privileged infrastructure access remain threats |
| Malicious manager | unit member/candidate identity | minimized projections, scope checks, disclosure thresholds | contextual knowledge can identify rare members |
| Sybil/farm | enrollment/duplicate accounts | verified person uniqueness across documents, rate limits, review | document fraud/provider false accepts remain |
| Deepfake/media injection | biometric assurance | reviewed PAD provider, injection-risk signals, attestation, manual appeal | measured FAR/FRR/PAD quality is UNKNOWN until evaluated |
| Notification provider | sensitive content/relationship metadata | content-free default, explicit policy+opt-in for non-sensitive previews | delivery destination/timing remain visible |
| Ballot-deanonymizing insider | choice/participation link | separated schema, coarse timestamps, randomized IDs, restricted logs, result suppression | low turnout and infrastructure timing observation remain; no absolute anonymity claim |

Data inventory: direct identifiers (vault, encrypted); pseudonymous IDs (profile/discovery, policy-controlled); biometrics (temporary encrypted review artifacts with explicit TTL/purge); organization/membership (sensitive graph); qualifications (possible quasi-identifiers); messages (private content and metadata); decisions (separated participation/ballots); audit/security (opaque actors, minimal payload, retained integrity history).

Legal/privacy decisions are **UNRESOLVED**: Georgian law and GDPR applicability, biometric processing basis, sensitive membership treatment, residency, retention/erasure, processor terms, notification processors, DPIA need. Obtain qualified review before real enrollment. No legal conclusion or real-person data processing is implemented in this foundation. Adults-only is a product default; a concrete age rule and enforcement require the enrollment decision.

## Enrollment migration gates

Review source application document/camera/device adapters. NFC DG1/DG2 reads alone do not establish authenticity: supported eMRTD flow needs SOD/passive authentication and signer chain against an appropriate CSCA trust source, plus active/chip authentication where supported. Provider/trust source and actual device results are UNKNOWN.
PAD covers photo/video replay, deepfake and media injection. Record actual provider metrics, face-match thresholds and false-reject/manual-review behavior. Keyed stable-person matching must handle passport and ID belonging to the same person; document-number uniqueness alone is insufficient. Device attestation informs risk and never weakens recovery. Temporary media retention requires encryption, purpose, access restrictions, TTL and purge tests.

## Interface architecture

Mobile has exactly Status / Messages / Home / Tasks / Polls; Home emphasized centrally in a safe-area floating pill. V1 Status shows Activity, personal contribution points/history, Qualifications and permitted Membership. No platform console, leaderboard or endless feed. Shared task/decision/event/profile/activity cards cover loading/empty/error/offline/pending states.
Web is one permission-aware management application. Group/region/professional/platform surfaces derive from capabilities and scope. Shared dialogs, filter bar, field validation, tables and state components use semantic design tokens. Georgian/English and system/light/dark are required. Web adapts source application layout; mobile uses a distinct day/night family.

## Migration sequence and rollback

| Phase | Deliverable / gate | Rollback |
|---|---|---|
| P0/P1 | read-only source assessment, isolated foundation, reviewed design/architecture | stop only ERTAD processes; retain project volumes |
| P2 | identity/enrollment/recovery/private profile | feature disabled; no source application data changes; restore drill before migration |
| P3 | organization/authorization/approval/audit/bootstrap | additive schema, deny-by-default feature gates; tested backup |
| P4 | actual Flutter and authenticated web shells | retain previous signed client/API compatibility |
| P5 | work/roles/assignments | additive migration and transaction/idempotency tests |
| P6 | basic channels/system notifications/moderation | disable delivery adapters; retain canonical records |
| P7 | decisions/privacy | no destructive ballot migration; reviewed explicit recovery plan |
| P8/P9 | Activity/Qualifications; promotion/sensitive access | append compensations; expire grants |
| P10/P11 | events/funding records/analytics; hardening/deployment | release rollback + measured restoration |
| P12 / V1.5 | network features | separate scope and feature rollout |
| P13 / V2 | gamification | derived state removable; authority unchanged |

source application production data existence and disposition are UNKNOWN. No migration/archive/discard operation is authorized by local infrastructure setup. Full source application security audit is pending; see [source assessment](SOURCE_ASSESSMENT.md).

## Acceptance gates

Foundation: deterministic install/build, unit/contrast checks, publication guard, Docker readiness, local API/web smoke, browser interactions/responsive widths, restricted role and restore probe. Future tests are **pending**, not fulfilled by foundation health:

- P2: invalid SOD/trust chain/replayed or injected media; duplicate person; false reject/recovery; attestation risk; default Private; no legal-name leak; temporary artifact purge (privacy/identity invariants).
- P3: correct/wrong permission and scope, expired membership, self-grant/self-approval denial, bootstrap non-reuse, break-glass alerts/audit if enabled, mobile-class denial, hash-chain and externally signed checkpoint verification.
- P5: concurrent final slot, child allocation capacity, idempotency conflict, revoked qualification and cancellation.
- P6: mute/block/moderation, content-free third-party defaults, deleting notification preserves source record.
- P7: ballot cannot join to participant, electorate floor 10, revealing-result suppression, logs/idempotency do not relink votes.
- P8/P9: immutable correction history, financial/referral/gamification non-authority, field grants expire.
- P12/P13: opt-in subscription, referral alone cannot broadcast, reward deduplication, private discovery anti-enumeration, rare attribute generalization, optional leaderboard, excused/organizer-cancelled events do not penalize reliability.

Scale goals are not validated capacity: 100k registered, 10k active; p95 read <300ms, write <800ms, authorization <20ms, message ACK <500ms. Initial realtime test hypothesis: 10k mostly idle connections and 100 message writes/s, fanout <=100; confirm workloads before P6. Test REST, realtime, notifications, decision transitions and search separately.
Recovery targets: RPO <=15min/RTO <=4h, requiring production PITR/encrypted offsite copies and timed drills. A local dump/restore does not satisfy these production targets.
