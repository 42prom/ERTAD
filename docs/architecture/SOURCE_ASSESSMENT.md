# DTG source assessment — limited foundation scope

Inspected 2026-10-01: local `../antygravity`, origin `42prom/Democracy-Tools-of-Georgia`, HEAD `a839b212516b7bee3601dc10aaab5e79a5f4b522` plus many uncommitted/untracked changes. Evidence below describes the inspected working tree, not a reproducible clean commit. The source was not modified or copied wholesale. This is not a completed full Stage 0 security audit.

| Source path | Observed responsibility | Classification / ERTAD impact |
|---|---|---|
| `admin/package.json:1`, `backend/package.json:1` | React/Vite and Node/TypeScript/Express packages | KEEP + MODIFY framework family; ERTAD locks its own minimal dependencies |
| `admin/src/components/Layout.tsx:29,130` | role-name menu and sidebar/breadcrumb shell | KEEP + MODIFY visual hierarchy; replace role-name authorization with scoped capabilities |
| `admin/tailwind.config.js:17` | slate/sky primary palette | KEEP + MODIFY semantic web tokens; accessible action shades |
| `admin/src/components/ui/Button.tsx:1`, `Input.tsx:1` | variants, labelled fields/errors | KEEP + MODIFY interaction vocabulary; shared ERTAD components |
| `admin/src/components/ui/Modal.tsx:1` | labelled modal overlay, sizes, header/content/footer | KEEP + MODIFY visual contract; ERTAD native dialog supplies focus containment/Escape/return |
| `mobile/lib/config/theme.dart:4`, `mobile/lib/main.dart:89` | dark surfaces and configured darkTheme | KEEP + MODIFY separate mobile family; light theme is a new provisional ERTAD design |
| `backend/src/routes/health.ts:1` | dependency probes and token-gated metrics | KEEP + MODIFY health concept, separate live/ready, generic public status; metrics gate pending |
| `backend/src/config/securityValidation.ts:1` | production configuration checks | KEEP + MODIFY fail-closed concept; foundation rejects production entirely pending real controls |
| `backend/src/middleware/requestId.ts:1`, `logger.ts:1` | request IDs and structured logging | KEEP + MODIFY; generated opaque IDs and route-template-only ERTAD logs |
| `docker-compose.yml:1` | isolated services, healthchecks, loopback ports, restricted app containers | KEEP + MODIFY; separate names/volumes/ports and local-first app development |
| `mobile/lib/services/verification/*`, `screens/enrollment/*` | paths for document, liveness and face verification | candidate KEEP + MODIFY; authenticity/PAD correctness UNKNOWN until full review/device tests |
| `backend/src/services/{identity,adminSession,appleAppAttest,auditCheckpoint}.ts` | identified identity/session/attestation/checkpoint modules | candidate reuse; security and migration compatibility UNKNOWN; do not certify from filenames |
| `backend/src/services/{blockchain,merkle,receiptSigner,zkProof}.ts`, `crypto/PoseidonHasher.ts` | identified national-election-related paths | NOT NEEDED in foundation; review before any migration; no deletion of DTG source |

Initial Docker inspection found other projects already using 3001, 3003, 3086, 5173, 5432, 5435, 6375, 6379, 8000, 8001, 8080; stopped containers also reserved 9000/9001. ERTAD uses 13000/15173/15432/16379/19000. Other projects were not stopped or repaired.

DTG test suite, full dependency audit, secret scan, full security/privacy analysis, production data migration feasibility and device enrollment assurance: **NOT RUN / UNKNOWN** in this foundation task. Perform these before reusing security-sensitive modules. ERTAD verification results live in [status](../STATUS.md).
