# ERTAD · ერთად

Organizational and community platform built from a complete imported application baseline. Web pages, Flutter/native adapters, backend modules and tests are present in the active source tree with ERTAD naming and isolated service endpoints. Development login uses email and password. Domain operations remain unavailable while their contracts are adapted.

## Start development

For the already configured workspace, open Docker Desktop and wait for **Engine running**. In a terminal at the ERTAD root:

```powershell
npm run infra:up
npm run dev
```

Keep that terminal open. The runner starts API/web, checks readiness, then connects the configured Cloudflare tunnel when `ERTAD_TUNNEL=true`. Quick-login behavior is preserved. Open [local login](http://localhost:15173/login), or the configured tunnel URL printed in the terminal.

To stop API, web and tunnel from another terminal in this same checkout:

```powershell
npm run dev:stop
```

`Ctrl+C` in the original dev terminal also stops them. To additionally stop this project's Docker data services, run `npm run infra:down`; existing database/storage volumes are preserved. Start again with `infra:up` then `dev`. Run `npm run db:migrate` before `dev` when new database migrations have been added. Do not start a second dev runner while the first is active.

If PowerShell blocks `npm.ps1`, use `npm.cmd` with the same arguments. If Docker is stopped, `infra:up` explains that Docker Desktop must be opened first. A port-in-use message means the existing dev runner or another application is still listening; `dev:stop` only addresses this ERTAD checkout and never kills unrelated applications. See [operations](docs/OPERATIONS.md#starting-and-stopping-development) for details.

First-time setup only:

Requirements: Node.js 24, npm, Docker Desktop with Compose, Git. From the repository root:

```powershell
npm ci
npm run setup
npm run infra:up
npm run db:migrate
npm run admin:bootstrap
npm run dev
```

Open [the login](http://localhost:15173/login). Bootstrap creates `admin@ertad.local` with a random password saved only in ignored `.local/ADMIN_ACCESS.md`. Enter the email and password; no authenticator code is required during development. Production startup remains blocked, and mandatory MFA for every web user is a production release gate. API readiness: [localhost:13000/health/ready](http://localhost:13000/health/ready).

Bootstrap is local-only, requires an empty administrator table on first use, and preserves an existing account on repeated runs. Restart the development runner after first bootstrap so it loads the new local configuration. The retained `superadmin` name controls legacy menu visibility only: legacy product APIs remain denied. The new membership-review API separately requires persisted member identity, scoped proposal/approval permissions and independent decisions. This does not implement production administrator enrollment.

API and Vite run locally with hot reload. To run in separate terminals, use `npm run dev:api` and `npm run dev:web`. Stop them with Ctrl+C. `npm run infra:down` stops only this project's Docker dependencies and preserves volumes. Do not add `-v` unless intentionally destroying local data.

| Service | Host port | Runtime |
|---|---:|---|
| API | 13000 | local Node/TypeScript |
| Web | 15173 | local Vite |
| PostgreSQL | 15432 | Docker, separate owner/runtime roles |
| Redis | 16379 | Docker, authenticated ephemeral state |
| S3 objects | 19000 | Docker SeaweedFS, private bucket `ertad-attachments` |

Application containers also listen on 13000/15173 internally. Data services keep their standard ports inside the isolated Compose network (PostgreSQL 5432, Redis 6379, S3 8333). Optional, inactive biometric/Shield code reserves defaults 18000/18080 and is not part of normal startup.

Ports are configurable in local `.env`; setup creates independent random credentials without overwriting an existing file. Never commit it. Preflight checks host listeners and existing/stopped Docker container bindings. Docker services and host API bind loopback only in the default development flow. Mobile hardware access will need a deliberately scoped development transport later.

## Check changes

```powershell
npm run check
npm run check:workspace
npm run smoke
npm run test:integration
npm run test:browser
```

For browser tests, install Chromium once with `npx playwright install chromium`, or use installed Chrome: `$env:PLAYWRIGHT_CHANNEL='chrome'`. Run `npm run check` first to create the normal web build, and keep local API/web running. Tests also start a temporary build preview on loopback port 15175 and fail if that port is occupied. `npm run tokens` updates CSS/Dart palettes from `design/tokens.json`; `tokens:check` prevents drift. Applying those tokens, bilingual labels and both themes across the original source application screens is part of the adaptation work.

`npm run check` typechecks the entire retained backend and web, runs foundation and transferred web unit tests, checks palettes and builds the active applications. `npm run test:integration` checks data-service isolation and local authentication against a disposable synthetic database; `npm run test:auth` runs that authentication suite alone. Legacy backend integration commands are not enabled: their database targets must first be replaced by disposable ERTAD test databases. The applied SQL lives in `backend/db/foundation`; copied `backend/db/migrations` files are reference history and are never run by `npm run db:migrate`.

Full container parity is optional: stop local API/Vite first, then `npm run stack:up`. Return to host development with `docker compose --profile apps stop admin backend` and `npm run dev`. Do not run both modes on the same ports.

See [architecture and phases](docs/architecture/FOUNDATION.md), [source application migration plan](docs/architecture/MIGRATION.md), [decisions](docs/architecture/DECISIONS.md), [operations](docs/OPERATIONS.md), and [verified status](docs/STATUS.md). Cryptocurrency and the old election protocol are removed across backend, web and mobile. Reusable authoring/question screens remain; mobile submission explicitly stays unavailable until the replacement Decisions contracts are implemented. The first [identity/access boundaries](docs/architecture/ACCESS.md) include typed credentials, fail-closed mobile startup, persisted organization/membership authority and an audited internal unit read. An [offline development governance bootstrap](docs/architecture/BOOTSTRAP.md) is tested but unarmed locally. The first [membership/position review inbox and in-app notifications](docs/architecture/APPROVALS.md) now run at `/reviews` with a scoped development API. This adds one recurring approval type; enrollment, other approval types and task/member operations remain pending. The existing local account has no implicit member authority. Flutter format/analyze and 54 unit/widget tests passed for the last mobile change; native builds and ERTAD device verification remain pending. Additional Python services are not started by ERTAD Compose. Optional application containers keep local login disabled by default; the local login account is used by the host development runner.
