# DTG to ERTAD migration plan

Planning baseline: 2026-10-01. This is an implementation plan, not a claim that DTG has passed a full security audit or that its features already run in ERTAD. Current executable status remains in [STATUS](../STATUS.md). Architecture, privacy boundaries and domain ownership are in [FOUNDATION](FOUNDATION.md).

## Starting point and preservation

Use the local DTG working tree as the source: its committed baseline is `a839b212516b7bee3601dc10aaab5e79a5f4b522`, with additional modified and untracked code and tests. A remote clone alone cannot capture those changes. Keep the source repository, index, running services and data untouched. ERTAD retains its own repository, credentials, volumes, ports, migration runner and CI.

A local, ignored inventory has recorded hashes for 338 allowlisted source/test/build files. This inventory includes 61 web files, 159 backend files and 99 mobile files, plus infrastructure/service inputs. It is an integrity reference, not a source backup or a completeness/security certificate. Assets, secrets and working instructions are outside that inventory; review asset provenance separately before copying. Source tests were inspected but not executed during planning.

Before the first code transfer:

1. Recheck the source commit, dirty/untracked paths and file hashes. Any concurrent source edit requires a fresh comparison; never overwrite it with a previous snapshot.
2. Create an isolated, local migration snapshot from an explicit allowlist of source, relevant tests and build inputs. Include the uncommitted security improvements. Exclude `.git`, environment files, signing material, service credentials, databases, biometric media, logs, generated builds, prompts, skills and audit working files. Review fixture contents and licenses before publication.
3. Validate copied hashes and record each transferred module's source path/revision, target path, dependencies, adapted tests and differences. Keep raw working inventories local; publish only the reviewed module decisions and implementation.
4. Run DTG baseline checks in that isolated copy after replacing test targets with disposable ERTAD test services. Some upstream integration tests use a live database; do not point them at DTG or reuse its `.env`. Existing failures are recorded and assessed before accepting a migrated feature.

## Reuse policy and completion measure

The DTG web application is the implementation baseline. Preserve at least 90% of applicable existing web journeys/structure where compatible with ERTAD requirements; this is a target, not an achieved percentage. Preserve the complete useful flow, its shared components and its test intent. The overall DTG reuse estimate remains unmeasured.

Keep a fixed inventory of original pages/components before deciding exclusions. Report original total, applicable total, preserved/adapted, replaced and excluded separately, with a reason for every exclusion. Do not inflate reuse by counting copied dead code, disabled pages or renamed files. New ERTAD functionality is reported separately. A retained UI with a missing backend is not a completed journey.

The current ERTAD web gallery validates infrastructure and tokens. It will become a development-only component route within the migrated shell. Replace overlapping primitives with one reviewed component family, preserving existing accessibility, Georgian/English and theme behavior. Avoid parallel old/new UI libraries with drifting behavior.

Classification below: **KEEP** retains behavior; **ADAPT** preserves a useful implementation but changes contracts or policy; **REPLACE** supplies new behavior with explicit regression coverage; **OMIT** excludes a DTG-specific subsystem from ERTAD; **LATER** belongs to V1.5/V2. None of these classifications deletes anything in DTG.

## Web transfer map

Paths in this table are relative to DTG `admin/src/`. The inventory covers all 22 current page files and their shared families.

| Source | Decision | ERTAD behavior / dependency |
|---|---|---|
| `App.tsx`, `components/Layout.tsx`, `components/SettingsLayout.tsx` | ADAPT first | Preserve routing, sidebar, breadcrumbs, settings tabs and loading boundaries; ERTAD naming, translations and semantic tokens. Replace role-name menus with capabilities + organization/unit scope. Route visibility never substitutes for API authorization. |
| `components/ui/*`, `index.css`, `utils/format.ts` | KEEP + ADAPT first | Reuse buttons, fields, selects, textarea, card, date/time picker and dialogs. Preserve validation and formatting; align focus, labels, touch targets, light/dark and responsive behavior. Adapt `RegionSelector` as a geography field, not as authority-tree enforcement. |
| `pages/Login.tsx`, API session/CSRF/step-up handling in `api/client.ts` | ADAPT | Server-backed browser sessions, MFA and recent reauthentication. New ERTAD origins/cookies; no inherited administrator passwords, cookies, sessions or bypasses. Depends on reviewed Identity/Security contracts. |
| `pages/AdminUsers.tsx` | ADAPT substantially | Reuse account/session administration interactions; replace global role assignment with eligible memberships, versioned permissions, scopes and independent approvals. Bootstrap is explicit and one-time. |
| `pages/Dashboard.tsx` | ADAPT | Scoped work, decisions, approvals and operational summaries. Replace election/wallet metrics with actual authorized data; no fabricated values. |
| `pages/Profiles.tsx` | ADAPT substantially | Scoped member projections, Private defaults and approved temporary identity-field access. No administrator-wide identity directory by rank. Counts, search and exports use the same disclosure policy. |
| `pages/CreatePoll.tsx`, `DraftedPolls.tsx`, `ActivePolls.tsx`, `PollDetails.tsx`, `VotingHistory.tsx` | ADAPT UI; REPLACE voting contract | Preserve authoring, draft/active/history, validation and detail patterns. Add organization/unit scope, eligibility snapshot, advisory/binding type and privacy mode. Remove rewards, blockchain receipts and national-election assumptions. Depends on the new Decisions module. |
| `components/ReferendumResults.tsx` | ADAPT presentation | Use as a results-view candidate; adapt allowed decision types and result suppression. No unsupported cryptographic-verification badge. |
| `pages/MessagesList.tsx`, `MessageEditor.tsx`, `components/MessagePreview.tsx` | ADAPT | Permission-scoped announcements and basic channel operations. Preview must respect recipient/context disclosure; third-party delivery defaults to content-free notifications. |
| `pages/Tickets.tsx`, `TicketDetail.tsx` | ADAPT | Minimal support/manual-review and moderation cases; redact attachments, restrict reviewers, audit access. Keep existing support interactions without creating a separate service. |
| `pages/SecurityLogs.tsx`, `components/AuditExportModal.tsx` | ADAPT | Scoped security/audit views and minimized exports. Separate request telemetry from immutable audit, remove identifying payloads and exclude ballot correlation fields. |
| `pages/SettingsRegions.tsx` | ADAPT | Geographic definitions/editing remain useful. Organization/Unit hierarchy is a separate model with one authority parent, cycle prevention and permission-controlled changes. |
| `pages/SettingsVerificationProviders.tsx`, `SettingsSecurity.tsx` | ADAPT | Policy validation, redacted secret inputs, MFA/step-up, approved sensitive changes and fail-closed provider configuration. Preserve relevant validation tests. |
| `pages/SettingsNotifications.tsx` | ADAPT | Delivery configuration and user preferences, minimal provider payload, consent plus organization policy for permitted previews. |
| `pages/SettingsGeoBlocking.tsx` | ADAPT selectively | Reuse policy editor only for justified network-risk controls. Country/VPN/IP signals neither prove identity nor grant authority; service outages cannot become authentication bypasses. |
| `pages/ShieldDashboard.tsx` | ADAPT selected views | Fold relevant health/risk/alert views into Security/Operations. Do not import the separate shield service automatically; each signal must have a purpose, retention rule and demonstrated need. |
| `pages/Insights.tsx`, `components/analytics/DemographicsCharts.tsx` | ADAPT safe UI; REPLACE queries | Scoped aggregate work/capacity reporting. Omit election demographic analysis; enforce small-cell suppression and protect sensitive group existence. |
| `pages/SettingsBlockchain.tsx` | OMIT | No blockchain settings or replacement placeholder page. |

New web surfaces use these migrated primitives: Organizations, Units/tree, Memberships, Positions/Permissions, Approvals, Work/Assignments, Qualifications and Definitions. Sensitive profile access and promotion have explicit approval journeys. Build one management app; capabilities change menus and actions for different scopes.

## Mobile transfer map

Paths are relative to DTG `mobile/` unless stated otherwise. Retain the enrollment experience and native adapters, while separating identity proofing from ordinary login and from device recovery.

| Source | Decision | ERTAD behavior / dependency |
|---|---|---|
| `lib/screens/enrollment/{intro,document_entry,document_camera,mrz_scanner,nfc_scan,selfie_camera,liveness,profile_creation}_screen.dart`, `enrollment_step_header.dart` | KEEP + ADAPT | Preserve capture instructions, camera/NFC handling, progress and errors. Use server-owned enrollment states/challenges and verified identity evidence. Profile creation defaults to Private. |
| `lib/services/liveness/*`, `lib/widgets/liveness/*`, `scanning_progress_indicator.dart` | ADAPT | Retain capture/animation/performance work. Client scores are usability/risk inputs only; accepted identity requires server-verifiable document/PAD/face results. Device evaluation determines actual assurance. |
| `lib/services/verification/*` | REVIEW + ADAPT | Keep useful interfaces/DTOs; separate synthetic providers from release composition. Mock/always-pass implementations and placeholder ML behavior cannot become production verification. |
| `lib/services/device_attestation_service.dart`, Android `MainActivity.kt`, iOS `AppDelegate.swift`, entitlements/build configuration | KEEP + ADAPT with tests | Preserve native Play Integrity Standard and App Attest evidence. Rename channels/app identifiers together, bind to ERTAD requests, retain server verification/counters and fail-closed behavior. ERTAD requires its own platform registrations/signing configuration. |
| `lib/services/secure_storage_service.dart`, `storage_service.dart` | ADAPT | Retain secure platform storage wrapper; review key accessibility, backup/restore, reinstall, token removal and device binding. Store minimal session state; no raw passport/media in preferences or logs. |
| `lib/services/biometric_gate.dart` | OMIT current stub; implement real gate if selected | Current compatibility stub returns success and is not an authentication control. No active caller was found in the inspected library. Local unlock must use a tested platform authenticator; it does not replace server authorization. |
| `lib/main.dart`, `config/app_config.dart`, `service_locator.dart`, `services/{api_service,real/real_api_service}.dart` | ADAPT composition; REPLACE duplicate transport/state wiring | One typed API layer, Riverpod/Dio/go_router as the target composition, feature-by-feature. Preserve device/capture adapters. Explicit ERTAD endpoints/flavors; no DTG production URL fallback. Replace poll-fetch-as-login-check with a dedicated session contract and distinct offline/expired/revoked states. |
| `lib/config/theme.dart`, `services/localization_service.dart`, `widgets/ui_components.dart` | KEEP + ADAPT | Preserve mobile visual character; generated independent mobile day/night tokens, Georgian/English, local fonts after license review, scaling and accessible states. No desktop admin layout on mobile. |
| `lib/widgets/bottom_nav.dart`, `screens/dashboard/*` | ADAPT structure; REPLACE destinations | Exactly Status / Messages / Home / Tasks / Polls; central Home. Relevant tasks, expiring decisions and announcements; no wallet or endless feed. |
| `lib/screens/activity/*`, `models/activity_item.dart` | ADAPT | Activity history, source and verification state, Qualifications and permitted Membership in Status. Remove reward/XP dependencies. |
| `lib/services/message_service.dart`, `notification_service.dart`, `widgets/message_*`, message model | ADAPT | System, global, group and private messages with server-side audience authorization; private content fetched after authentication, not put into third-party push payloads. |
| `lib/screens/settings/*`, ticket model | KEEP + ADAPT | Language, notification preferences, help/support and device/session management. New identity recovery/manual appeal must use restricted review and audited outcomes. |
| `lib/screens/voting/*`, `vote_history_screen.dart`, poll model | ADAPT presentation; REPLACE protocol | Active/history, eligibility, deadline, privacy mode and confirmed participation state. Reuse ordinary question UI where required; remove receipt/chain/reward contracts and test the new unlinkable decision flow. |
| `lib/screens/wallet/*`, `wallet_service.dart`, transaction/reward models, `receipt_verification_screen.dart` | OMIT | No cryptocurrency, wallet keys, send/receive, wallet QR, or ballot-receipt verification. A generic QR decoder may be reconsidered in V1.5 without a wallet dependency. |

Feature layout is `mobile/lib/features/<feature>/...`; create data/domain/presentation boundaries only when the transferred feature needs them. Preserve proven capture behavior while changing dependency wiring in small tested steps. Do not rewrite every controller just to change a state-management library.

## Backend, data and infrastructure transfer map

Paths are relative to DTG `backend/src/` unless stated otherwise.

| Source | Decision | Target and changes |
|---|---|---|
| `routes/enrollment.ts`, `services/identity.ts`, `verificationSettings.ts`, `biometrics.ts`, `services/verification/*` | ADAPT under Identity | Explicit enrollment state machine, schema validation, signed document evidence, person-level uniqueness from verified attributes, replay defense, recovery and minimal retention. Remove request-body/identity logging and schema changes from request handling. |
| `services/deviceAttestation.ts`, `appleAppAttest.ts`, native client counterparts | KEEP + ADAPT under Identity/Security | Preserve validation primitives and regression tests; generalize vote-bound operations with versioned ERTAD action binding. Audit initial pre-account device registration separately from authenticated key use to avoid circular trust. |
| `services/credentials.ts`, `routes/auth.ts`, credential middleware | ADAPT/REPLACE contract | Separate authenticated person/session/device from organizational authority and anonymous decision participation. Revocable server-side state, bounded credential lifetime and session-class enforcement. |
| `services/{adminSession,adminMfa,adminPassword,secretEncryption}.ts`, `routes/admin/auth.ts` | KEEP + ADAPT | Reviewed cookie/CSRF/MFA/step-up primitives and tests. Add ERTAD bootstrap, revocation and key lifecycle; no legacy administrator fallback. |
| `middleware/adminAuthorization.ts`, role checks throughout routes | REPLACE policy; retain boundary tests | User + active Membership + versioned Permission + Scope, plus required independent Approval/temporary field grant. Positions and cached token roles never mean universal allow. |
| `services/security.ts`, `auditCheckpoint.ts`, `auditExport.ts`, audit routes | KEEP + ADAPT under Security | Extract serialized audit-chain and strict transactional writes; minimize payloads. Preserve signed checkpoints to independent append-only/version-locked storage. Separate election/device-linking helpers from the general audit service. |
| `routes/profile.ts`, `routes/admin/profiles.ts`, identity-vault patterns | ADAPT | Separate encrypted legal identity from profile projections. Authorized exact-ID lookup, Private default, field grants, non-enumerable membership, coarse attributes where necessary. |
| `routes/messages.ts`, `routes/admin/messages.ts`, `pushNotifications.ts`, `routes/devices.ts`, ticket services/routes | ADAPT under Communication/Security | Scoped channels, delivery ownership, mute/block/moderation, minimal notifications. A push token is a delivery address, not proof of device/user identity. |
| `services/{polls,pollValidation,surveyVoting,voting,pollMonitor}.ts`, poll routes | ADAPT validators; REPLACE decision persistence/protocol | Reuse relevant date/question/state validators and tests. New electorate snapshot, unique participation, unlinked ballots, threshold/result suppression and concurrency tests. Remove crypto/reward coupling even from otherwise simpler survey paths. |
| `services/analytics.ts`, insights/stats routes | ADAPT authorized aggregates | Work/capacity/decision aggregates only where policy permits; no raw member exports, political scoring or identifying small breakdowns. |
| `middleware/{rateLimit,dynamicRateLimit,idempotency,security,logger,requestId,errorHandler}.ts`, configuration validation, `outboundUrl.ts` | KEEP existing ERTAD base; port useful improvements | One reviewed middleware chain. Preserve production configuration denial, SSRF checks for configured destinations, minimal logging and targeted limits. Ordinary mutation idempotency must not be reused blindly for anonymous ballots. |
| `db/migrations/*`, owner/runtime role work | ADAPT selected constraints into new ERTAD migrations | Keep the current serialized/checksummed runner and restricted role. Transfer table intent when its slice ships; do not execute DTG's whole schema or import its databases/secrets. |
| `services/{blockchain,merkle,receiptSigner,zkProof,voteAnchor,voteEncryption,nullifier,rewardProcessor}.ts`, election crypto scaffolding; wallet/reward routes | OMIT old product subsystem | Review needed uniqueness/privacy guarantees before replacement. Keep standard cryptographic primitives where needed for authentication, encryption and audit signatures; removing cryptocurrency does not remove cryptography. |
| `../biometric-service/` | ADAPT candidate, separate runtime boundary | Review model license, PAD effectiveness, image input limits, service authentication, encryption, memory/disk retention and error handling. Existing models/thresholds are not accepted assurance evidence by themselves. |
| `../dtg-shield-service/` | NOT NEEDED as a default service | Map useful checks to the monolith/operations first; add a separate runtime only with a demonstrated need and ADR. |
| Upstream Docker, CI, backup/security scripts | ADAPT selected checks | Preserve ERTAD host development and isolated data services. Review scan scope/tool output, port targets, database names and destructive commands before use. No production deploy or global cleanup. |

New ERTAD domain work: Organization/Unit/Membership; versioned Position/Permission/Scope; Approval and temporary identity grants; WorkItem/Role/Assignment; Qualification; append-oriented Activity; Event and non-authoritative contribution records. Existing UI and infrastructure support these modules; they do not already implement their invariants.

## Zero Trust contract

Zero Trust is a server-enforced property across mobile, web, services and data. Device ownership, a trusted-looking app screen, network location or a successful prior enrollment grants no implicit access. This follows the separation of identity/device checks and resource access in [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final). The following rows are ERTAD acceptance requirements, not a certification of current code.

| Boundary | Required behavior | Negative acceptance tests |
|---|---|---|
| Client input | Server validates schema, state and authenticated subject. Ignore caller-supplied roles, verification flags, organization headers and biometric success scores as authority. | Modified app/direct HTTP cannot self-verify, change user, self-grant or cross organization scope. |
| Session | Verify validity, class, revocation and necessary assurance on every protected request; re-evaluate memberships/permissions when changed. | Expired/revoked/disabled sessions, wrong audience/class and stale membership grants fail; mobile credentials cannot call protected web admin APIs. |
| Device evidence | Validate provider evidence on the server, expected ERTAD app identity/environment and fresh action binding. One-time challenges have bounded TTL and atomic consumption. | Wrong app, wrong action/body/subject, stale/reused challenge, invalid signature, duplicate concurrent submission, unsupported provider and missing configuration cannot pass. |
| Platform-specific proofs | Retain Android Standard request-hash verification and iOS key registration/assertion verification with monotonic counters and concurrent-update protection. | Changed request hash; cross-account key use; unregistered/revoked key; repeated counter; development proof against release policy. |
| Risk/outage policy | Attestation is one risk/assurance input, never identity or authority by itself. Missing evidence cannot be labelled valid. Block operations requiring that assurance; offer retry or an independently secured recovery route. | Provider outage/unsupported device cannot turn into automatic enrollment, a successful vote, privilege grant or biometric bypass. Public help remains available. |
| Browser | HttpOnly/Secure/SameSite session design, CSRF, MFA, short-lived privileged assurance and step-up for sensitive operations. | Forged/absent CSRF, copied mobile token, expired step-up and self-approval fail even when UI controls are bypassed. |
| Storage and services | Restricted DB credentials, tenant-scoped queries/constraints, private object access, authenticated service boundaries and separate identity keys. | Cross-tenant foreign keys/queries and object URLs fail; API role cannot assume owner; verification service is not an unauthenticated public endpoint. |
| Offline client | Separate UNKNOWN/OFFLINE from authenticated confirmation; only deliberately allowed minimized cached reads. Clear or hide protected state according to logout/revocation/cache policy. | Network failure cannot assert a new valid session or mark enrollment, votes, approvals, role grants or security changes successful. |
| Release configuration | Real provider composition; no always-pass biometric gate, mock evidence, legacy admin fallback, insecure endpoint or weak default secret. | Release artifact/config checks and startup tests reject each unsafe mode. Synthetic test injection is isolated from shipped composition. |
| Sensitive decisions | Keep device/identity assurance outside stored anonymous ballots and their telemetry. | No user/device/session/nonce/attestation binding/request ID/hash joins choices to a participant, including retries, logs, exports and backups. |

Preserve native plus server plus tests as one unit. Google's [Standard request flow](https://developer.android.com/google/play/integrity/standard) requires backend verification of the evidence and request binding. Apple's [App Attest validation guidance](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server) supplies the validation contract for challenges, keys and assertions. Changing package IDs, signing certificates, team/bundle IDs or environments requires corresponding verifier configuration and new device evidence; DTG registrations are not silently reused.

Local code inspection found vote-focused attestation code and relevant new tests; it did not prove that every enrollment/recovery path already applies the same checks. Complete that path-by-path mapping before the first protected ERTAD flow is enabled.

## Identity continuity, biometric reference and recovery

First enrollment: server challenge/session -> supported document reading -> SOD/data-group integrity and trusted signer validation -> PAD and face match -> verified stable-person uniqueness -> account with Private profile -> bound device/session. Invalid, incomplete or untrusted evidence stays unverified. Client flags and document-number uniqueness alone are insufficient.

Use a stable keyed person identifier derived from verified attributes, with issuer namespace and key-version/rotation handling. Passport and compatible ID for the same person must converge; renewed documents must not create duplicate people. Database uniqueness and race tests enforce this. Keep the mapping in Identity, separate from normal profile fields.

The requested remembered biometric reference is a proposed identity-continuity control. Before activation, decide whether a protected reference template is necessary in addition to renewed document verification, and document its purpose, provider/model version, matching threshold, encryption/key custody, access, bounded retention and deletion from backups. A template remains sensitive data, is not an anonymous hash, and is not a sole login/recovery factor. Raw document photos and liveness media expire and purge; do not retain them indefinitely to support an unspecified future comparison. Do not silently replace a trusted reference after a mismatch or use it for general face search.

| Situation | Planned handling |
|---|---|
| Same-device routine use | Server session plus protected device credential; optional real local biometric/PIN activation. No passport read on every app opening. |
| New device, old device available | Fresh device evidence and strong reauthentication/identity continuity check; old-device confirmation is an additional signal. Register the new key explicitly and show the device/session change. |
| Lost/stolen phone | Re-proof identity with trusted document + PAD/face checks and the approved continuity policy; revoke compromised sessions/keys and notify through a safe channel. No SMS/email-only downgrade. |
| Renewed passport or passport-to-ID change | Verified stable-person match and approved continuity check; preserve the existing account and history. Document number change alone cannot create/transfer ownership. |
| Expired/unreadable document, false rejection or unavailable integrity service | Explicit pending/retry/restricted appeal. Independent authorized review and audit; no support-agent direct override of identity or silent template replacement. |

Administrative reviewer access itself requires scoped permissions, independent approval where sensitive, expiring field access and audit. Recovery cannot be weaker than enrollment. No real identity or biometric fixtures are copied during migration.

## Test preservation and acceptance

Existing test files are candidates and evidence of test intent, not passing results. Migrate relevant tests with the implementation, update contracts and preserve negative assertions. Some mobile tests check source text or local mock values; supplement them with server integration and physical-device evidence. Remove obsolete product tests only with an explicit mapping to replacement behavior or an omitted feature.

| DTG test group | ERTAD transfer |
|---|---|
| `backend/tests/device-attestation.test.ts`, native-binding cases in `mobile/test/voting_flow_test.dart` | Preserve malformed/stale/unbound/wrong-subject rejection; add atomic replay/counter races, new ERTAD app identity and enrollment/recovery operations. |
| `admin-authorization`, `admin-security-primitives`, `admin-settings-security`, `admin-audit`, `admin-export` tests | Keep cookie/CSRF/MFA/step-up, encryption-tampering and denial cases; replace role fixtures with two organizations, overlapping memberships, expired scope and independent approvers. |
| `vault-security`, `security-validation`, `database-role-security`, `error-handler-security`, `health-security` tests | Preserve fail-closed configuration, runtime-role and error-redaction tests alongside existing ERTAD foundation checks. |
| `audit-chain-locking`, `audit-checkpoint`, `audit-export-privacy`, `idempotency-privacy`, `ballot-envelope-privacy` tests | Preserve concurrency, signed checkpoint and privacy intent; validate the new data model, external destination and decision retry protocol. |
| `enrollment-e2e`, `auth`, `nonce`, related integration tests | Rebuild fixtures as synthetic, replace live/default DTG service targets; add authenticity, duplicate-person, mismatch, recovery, retention and purge cases. |
| `poll-validation`, `survey-voting`, survey integration tests | Retain useful input/lifecycle/concurrency assertions; remove reward/transaction-hash assumptions and cover the replacement decision contract. |
| Web `AdminUsers`, `Profiles`, `SettingsRegions`, `CreatePoll`, `Insights` tests | Preserve interaction regressions; adapt privacy/scope, unauthorized counts, new domain labels and error states. |
| Mobile accessibility/footer/admin-compliance and app smoke tests | Preserve member-only intent and usability, update exact five tabs, add both themes/languages, text scaling, denied permissions, offline and session transitions. Do not preserve a blanket deep-link ban as a substitute for actual route authorization. |
| Wallet, Merkle/ZK and old receipt-protocol tests | OMIT obsolete product expectations; retain independent cryptographic primitive tests if the primitives still serve authentication/audit. |

Every phase must account for the invariants below through automated tests, or a specific written reason and manual evidence when automation cannot establish the property.

| Invariants | Acceptance owner / gate |
|---|---|
| I1 authorization; I2 no self-grant/approval; I3 rank does not reveal identity | P3 permission/scope and approval integration, P9 field-grant expiry and identity-access tests |
| I4 financial; I5 referral; I6 gamification do not grant authority | P3/P7 eligibility takes only explicit policy inputs; P10/P12/P13 regression before introducing each new signal |
| I7 append-oriented Activity | P8 immutable history with tested reversals/corrections |
| I8 external signed audit checkpoints | P3 chain concurrency, independent signature verification, external delivery/immutability failure handling |
| I9 authorized search; I16 Private default; I17 non-enumerable membership | P2/P3 projection and lookup tests; every list/count/export/analytics endpoint; rare-attribute policy tests |
| I10 production fails closed; I11 mobile is not admin; I12 no hidden tracking | Release configuration and session-class rejection; mobile artifact/permission review; any future location feature needs explicit visible, revocable policy |
| I13 biometric minimization; I15 minimal PII in append-only stores | P2 artifact lifetime/access/purge tests; P3 audit payload and erasure-mapping tests |
| I14 private notifications; I18 referral is not communication authority | P6 provider payload and audience authorization; P12 tests before referral/subscription features exist |

Decision gates additionally require electorate snapshot, minimum anonymous electorate 10, suppression of revealing results and indirect-join analysis. Work gates require concurrent final-slot allocation, hierarchy capacity, payload-bound idempotency and revoked-qualification denial. A UI test cannot establish these database/server properties.

## Delivery order and rollback

The phases refine the existing P0–P13 roadmap. P1 migrates presentation early; P4 completes authenticated shells after Identity and Authorization gates. This allows visual reuse without exposing unreviewed product routes.

| Phase / branch family | Concrete deliverable | Prerequisite and exit evidence | Rollback |
|---|---|---|---|
| P0 / `docs/` then `infra/` | Source inventory/snapshot, exact reuse map, isolated upstream test baseline and security review | Source unchanged; selected files/fixtures reviewed; real check results and unresolved findings recorded | Remove only the disposable ERTAD review copy if no longer needed; original DTG untouched |
| P1a / `feat/dtg-web-shell` | Actual DTG layout/routing/settings shell and UI primitives adapted to ERTAD; migrate relevant component tests | P0 selected UI review; build, Georgian/English, web light/dark, keyboard/dialog/filter and responsive tests. Only implemented routes shown; gallery is development-only | Revert slice; foundation API/data services remain usable |
| P1b / `feat/dtg-mobile-shell` | Runnable Flutter composition, themes/localization, five destinations, reviewed capture/native adapters behind unverified flow | P0 selected mobile review; pinned Flutter/toolchain/dependencies, format/analyze/tests and Android debug build. New app IDs/config; no mock verification in release composition | Retain previous build and API contract; no identity data migration |
| P2 / `feat/identity-*` | Identity/session/recovery contracts, additive tables, migrated enrollment UX with real evidence validation, Private profile | P0 security review; minimal strict audit events available before consequential identity mutations; all identity/Zero Trust negative tests. Synthetic integration first; device/provider and data-processing gates before real enrollment | Feature disabled by default until accepted; backward-compatible additive migration, backup before data change; fail-closed rollback of affected sessions |
| P3 / `feat/governance-*` | Organization/Unit/Membership, versioned permissions, Approval, full audit/checkpoints, one-time MFA bootstrap | P2 identity, tenant constraints, cycle/race checks, no self-approval, mobile-class denial, checkpoint failure tests | Disable new mutations, keep audit/history; reviewed restore/forward-fix for schema/data |
| P4 / `feat/management-*` | Connect migrated web management and member navigation to accepted capabilities/APIs; session/device management | P2/P3; end-to-end correct/wrong-user/wrong-organization tests; real mobile/web assurance evidence | Keep previous compatible clients; route/capability rollback cannot bypass API policy |
| P5 / `feat/work-*` | Tasks, roles, applications, assignments, hierarchical delegation and minimum qualification eligibility | P3/P4, minimal Qualifications model when eligibility first needs it; transaction/idempotency/capacity tests | Stop new assignments if necessary; preserve existing allocations and history |
| P6 / `feat/communication-*` | Basic text channels, system notifications, mute/block/moderation and support | P3/P4; audience/notification privacy, delivery retry and abuse tests. No V1.5 subscription system | Disable delivery adapter; canonical messages/decisions/tasks remain intact |
| P7 / `feat/decisions-*` | Adapted poll UI and simple decision engine with separate participation/ballots | P3/P4 and audit foundations; protocol/schema/telemetry privacy review, electorate/duplicate-vote races, device assurance | Never rewrite active ballots destructively; documented close/pause/recovery and compatible old-client handling |
| P8/P9 / `feat/activity-*`, `feat/qualification-*` | Full Activity/Qualifications, promotion and temporary sensitive access | Relevant P5/P7 event sources; reversals, revocation, independent approval, expiry and audit tests | Compensating records and expired grants; no silent history edits |
| P10 / `feat/operations-*` | Events, contribution records and scoped aggregate reporting | Existing Work/Activity/Approval; cancellation/capacity/privacy and non-authority tests | Disable projections/adapters; preserve canonical history |
| P11 / `infra/`, `fix/` | Observability, secret rotation, offsite recovery, load/device/accessibility/security release gates | All V1 invariants plus measured restoration/load and supported-device matrix. Production remains a separate release decision | Tested release rollback and measured data recovery |
| P12/P13 | V1.5 network, then V2 gamification | Separate scope: referrals/subscriptions/public channels/QR/discovery; later XP/levels/recognition | Independent rollout; no effect on core authority |

P2 depends on a minimal audit transaction contract; it must not wait until P3 to start logging consequential identity actions. The full organization policy, external checkpoint service and governance console complete in P3 before production. P5 may introduce minimal Qualifications eligibility before the full P8 interface. These are explicit dependencies, not permission to create empty frameworks upfront.

First implementation package is **P0 baseline + P1a DTG web shell**. Its scope is the actual shared UI and routing; no copied production endpoints, fake authenticated pages or whole DTG database. P1b can follow once its native/build inputs are reviewed. Identity/backend review proceeds before connecting either client to protected product operations.

## Decisions to settle at their gates

| Decision | Recommended planning default / remaining evidence | Needed before |
|---|---|---|
| Source of truth | Local working tree plus immutable per-transfer hashes; no upstream commit/push required to preserve the user's work | First transfer |
| Application identity | New ERTAD Android/iOS identifiers, isolated signing/provider settings and explicit environments; exact IDs and developer-account provisioning still to be set | Native attestation/device validation |
| Hardware development transport | Keep data ports loopback. Prefer explicit emulator/USB forwarding where supported; physical-device TLS/controlled access configured deliberately. No inherited DTG tunnel or public service URL | Real device integration |
| CSCA/document trust | Reviewed trust source and supported document matrix, signature/chain/revocation policy and fixtures; unsupported evidence denied | Real enrollment |
| PAD/face engine | Evaluate DTG implementation first; establish license, spoof resistance, thresholds and false-reject handling with measured/provider evidence | Real biometric verification |
| Retained biometric reference | Minimal protected reference only after necessity, retention/deletion, key custody, recovery behavior and applicable data-processing review are settled | Reference storage activation |
| Privacy/age | Adults-only initial policy; concrete eligibility and legal/privacy requirements require qualified review, with no assumed jurisdictional conclusion | Real-person onboarding |
| Legacy records | Fresh ERTAD data is the current development assumption. DTG production-data existence/disposition remains UNKNOWN; migration/archive decisions are separate | Any real data transfer |
| External audit checkpoint | Independent append-only/version-locked destination, separate keys and outage handling; local S3 health is not proof of independent immutability | Production governance |
| Release assurance | iOS build/signing on supported macOS tooling, physical Android/iOS enrollment/attestation cases, security review and operational recovery evidence | Production/client distribution |

## Verification of this planning change

The source inventory and selected code/test reads were read-only. No DTG test suite, source mutation, data transfer, application-code migration, provider enrollment or deployment is claimed by this plan. Existing ERTAD checks/builds, dependency audit, publication guard and documentation links passed; source hashes and Git state remained unchanged. Actual results are recorded in [STATUS](../STATUS.md). Subsequent transfer PRs must carry their own behavior, security and runtime evidence.
