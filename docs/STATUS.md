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

1. Complete the read-only DTG review of document authenticity, liveness/face verification, sessions, device attestation, identity uniqueness and audit checkpoints. Record reproducible evidence and reuse decisions; do not copy security-sensitive modules before review.
2. Define P2 enrollment/profile/recovery states and API contracts, including Private defaults, legal-identity separation, replay protection, cross-document person matching, recovery/session revocation and temporary-artifact purge. Resolve provider/trust-source dependencies explicitly; unsupported verification remains denied.
3. Implement the first reviewed identity vertical slice with synthetic fixtures and its negative-path tests. Keep production startup disabled until the applicable security and operational gates are satisfied.

P3 introduces organization/permission/approval/audit foundations. Real Flutter migration and device testing remain pending. V1.5 network and V2 gamification remain outside V1.
