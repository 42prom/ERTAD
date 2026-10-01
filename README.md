# ERTAD · ერთად

Organizational and community platform. Current stage: a local development foundation with health-only API and a bilingual design gallery. No production identity, governance or voting features are enabled.

## Start development

Requirements: Node.js 24, npm, Docker Desktop with Compose, Git. From the repository root:

```powershell
npm ci
npm run setup
npm run infra:up
npm run db:migrate
npm run dev
```

Open [the web app](http://localhost:15173) or [the component gallery](http://localhost:15173/#design). API readiness: [localhost:13000/health/ready](http://localhost:13000/health/ready).

API and Vite run locally with hot reload. To run in separate terminals, use `npm run dev:api` and `npm run dev:web`. Stop them with Ctrl+C. `npm run infra:down` stops only this project's Docker dependencies and preserves volumes. Do not add `-v` unless intentionally destroying local data.

| Service | Host port | Runtime |
|---|---:|---|
| API | 13000 | local Node/TypeScript |
| Web | 15173 | local Vite |
| PostgreSQL | 15432 | Docker, separate owner/runtime roles |
| Redis | 16379 | Docker, authenticated ephemeral state |
| S3 objects | 19000 | Docker SeaweedFS, private bucket `ertad-attachments` |

Ports are configurable in local `.env`; setup creates independent random credentials without overwriting an existing file. Never commit it. Preflight checks host listeners and existing/stopped Docker container bindings. Docker services and host API bind loopback only in the default development flow. Mobile hardware access will need a deliberately scoped development transport later.

## Check changes

```powershell
npm run check
npm run check:workspace
npm run smoke
npm run test:browser
```

For browser tests, install Chromium once with `npx playwright install chromium`, or use installed Chrome: `$env:PLAYWRIGHT_CHANNEL='chrome'`. Browser tests assume the local app is running. `npm run tokens` updates CSS/Dart palettes from `design/tokens.json`; `tokens:check` prevents drift.

Full container parity is optional: stop local API/Vite first, then `npm run stack:up`. Return to host development with `docker compose --profile apps stop admin backend` and `npm run dev`. Do not run both modes on the same ports.

See [architecture and phases](docs/architecture/FOUNDATION.md), [DTG migration plan](docs/architecture/MIGRATION.md), [decisions](docs/architecture/DECISIONS.md), [operations](docs/OPERATIONS.md), and [verified status](docs/STATUS.md). The Flutter directory currently contains generated palette constants and a migration boundary, not a runnable mobile app.
