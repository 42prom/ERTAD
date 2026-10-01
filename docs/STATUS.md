# Verified foundation status

Verified locally and in GitHub Actions on 2026-10-01. Scope: foundation only; no production deployment.

## Implemented

- Node 24/TypeScript/Express health API; `/api/v1/*` fails closed, request IDs/minimal structured logs, security headers, production startup rejection.
- React/Vite local development shell, Georgian/English, system/light/dark preferences, DTG-informed visual family, shared button/field/dialog, filterable component gallery and independent mobile palette preview.
- One generated token source for CSS/Dart. Runnable Flutter app migration is pending.
- Isolated PostgreSQL 17, Redis 7, SeaweedFS S3 dependencies on loopback 15432/16379/19000; local API 13000/web 15173. Owner/runtime DB separation, authenticated Redis, private S3 bucket, versioned checksum-checked/serialized migrations.
- Optional `apps` Compose profile for full-container parity; pinned image digests, non-root/read-only application containers, health-based startup, bounded logs.
- Local-only prompts/instructions/audit workflow, Git/Docker exclusions, pre-commit/pre-push publication guard including local credential checks, main/master push block.
- CI workflow, dependency update configuration, architecture/threat/privacy/test plan, staged migration plan and operational runbook.

## Verification evidence

| Check | Result |
|---|---|
| `npm run check` | PASS: generated token drift check, both TypeScript projects, 3 API tests, 4 palette contrast tests, API/web builds |
| `npm audit --audit-level=high` | PASS: 0 reported vulnerabilities at verification time |
| `npm run check:workspace` / `git check-ignore` | PASS: local instructions, master brief, skill copy, working reports and `.env` excluded; generated credentials not found in publishable files |
| Docker default data services | PASS: PostgreSQL, Redis and S3 healthy |
| `npm run smoke` | PASS: live/ready, web proxy, product API 401 and web response in local-app mode |
| `npm run test:integration` | PASS: restricted DB role and denied owner/schema access; Redis auth/anonymous denial; S3 object roundtrip/anonymous 403 |
| `npm run restore:drill` | PASS: dump restored into separate random scratch DB, migration checksums match, scratch objects cleaned |
| `npm run test:browser` with installed Chrome | PASS: 2 scenarios; language/theme persistence, system-theme changes, filters, Escape/focus restore; no horizontal overflow at 360/390/768/1440 in both themes |
| Optional Docker API/nginx/web | PASS: built and healthy; smoke/browser scenarios passed on alternate 13001/15174 while local apps stayed available; optional app containers stopped afterwards |
| Visual inspection | Desktop gallery screenshot inspected; no Flutter device or full screen-reader validation claimed |
| GitHub Actions Foundation | PASS: [run 36910401234](https://github.com/42prom/ERTAD/actions/runs/36910401234), code commit `28d05e04a11a1df1157a3e7ce31ea2ecf075b943`; clean install, publication guard, checks/build, dependency audit, Compose validation, full container stack, smoke, integration, restore drill and Chromium browser tests all succeeded |

## Remaining gates

Full DTG security audit and production data disposition; real identity/enrollment/recovery; all domain operations and v5 privacy/authorization invariants; one-time admin bootstrap/MFA; legal/privacy review; externally signed audit checkpoints; biometric retention; production metrics/alerts/secret management; encrypted offsite PITR and object recovery; load tests; real Flutter app/device validation. Current readiness means the local foundation is usable, not that the platform is production-ready.

GitHub remote is `https://github.com/42prom/ERTAD.git`; foundation branch is `infra/foundation`. Hosted CI passed for the code commit linked above. Branch protection is **not enabled** (GitHub branch metadata checked 2026-10-01); local hooks do not provide server enforcement. The remote was empty at initial inspection, and no main branch or PR base has been established.

## Next implementation gate

The [DTG migration plan](architecture/MIGRATION.md) now defines web/mobile/backend transfer decisions, preservation of uncommitted security tests, an explicit Zero Trust acceptance matrix, identity continuity/recovery, phase dependencies and rollback. Planning inventory: 338 allowlisted local DTG source/test/build files hashed against commit `a839b212516b7bee3601dc10aaab5e79a5f4b522` plus working-tree changes. This is not a source backup, complete security audit or passing DTG test run. Application code has not been migrated by the planning change.

Planning-change validation on 2026-10-01: `npm run check` PASS (3 API tests, 4 palette tests, typechecks/builds/token checks); `npm audit --audit-level=high` PASS (0 reported vulnerabilities); publication guard and `git diff --check` PASS; 14 local documentation links/anchors verified; all 338 inventoried DTG file hashes, source commit and working-tree status unchanged. These local results do not claim a new hosted CI run or DTG/device test execution.

1. Recheck source changes and create the isolated, reviewed migration snapshot; run the selected upstream baseline with disposable ERTAD test targets. Preserve new security tests and their assertions.
2. Transfer the actual DTG web shell/shared components and tests (P1a), then the runnable Flutter shell/native adapters (P1b). Keep product routes unavailable until their backend/security contracts are accepted. Target broad reuse of applicable web behavior; no achieved reuse percentage is claimed.
3. Complete security-sensitive DTG review and P2 enrollment/profile/recovery contracts, including minimal strict audit events, Private defaults, legal-identity separation, action-bound integrity evidence, cross-document person matching, recovery/session revocation and artifact purge. Resolve provider/trust-source and retained-reference dependencies explicitly.
4. Implement reviewed identity slices using synthetic fixtures, then P3 scoped governance/audit and P4 authenticated client flows. Keep production startup disabled until the applicable security and operational gates are satisfied.

P3 introduces organization/permission/approval/audit foundations. Real Flutter migration and device testing remain pending. V1.5 network and V2 gamification remain outside V1.
