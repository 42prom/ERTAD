# Local operations

Run commands from the repository root. Compose project is fixed to `ertad`; do not operate on unrelated projects or prune Docker globally.

## Development and checks

`npm run setup` preserves existing `.env` and creates credentials only for a new file. `npm run infra:up` checks ports and starts only PostgreSQL/Redis/S3. `npm run db:migrate` runs owner-authenticated migration separately from the runtime API; checksum drift aborts, and advisory lock serializes migrators. `npm run dev` starts local API and Vite with reload.

`npm run smoke` requires the API and web running. `npm run test:integration` verifies database privilege separation, authenticated Redis, private S3 object roundtrip and anonymous denial. `npm run restore:drill` creates a fresh randomly named scratch database, restores a dump and compares migration checksums, then removes only its own scratch database/dump. This tests the current foundation database, not production RPO/RTO or attachment recovery.

If API readiness is 503, verify `docker compose ps`, then `npm run db:migrate`; liveness only indicates the API process is alive. All three dependencies are mandatory for foundation readiness. Secrets are not printed by setup or normal checks. Avoid sharing `docker compose config` or full inspect output because resolved environment includes credentials.

`npm run preflight` intentionally fails when planned app ports are occupied by host processes; stop the existing development runner before using it to launch a second environment. It recognizes this project's running container ports and detects stopped foreign container reservations. Bind is ultimately enforced at actual startup; a preflight cannot eliminate races.

## Lifecycle and recovery

- Stop local app terminals with Ctrl+C; `npm run infra:down` preserves volumes.
- To test all containers, stop local apps, `npm run stack:up`, then smoke/browser/integration checks. Return using `docker compose --profile apps stop admin backend`, then `npm run dev`.
- Changing an existing `.env` password does **not** rotate an initialized database or S3 identity automatically. Preserve the file, or explicitly rotate credentials in the services and update clients together. Do not reset volumes to work around authentication on data you need.
- Never use `docker compose down -v` as ordinary cleanup. Record and inspect backups before any intentional local data reset.
- Node/API/admin containers run as non-root with read-only filesystem and dropped capabilities. Database/storage containers retain upstream runtime needs. Docker volumes are persistent, not backups.
- Redis is ephemeral and authenticated. Current policy is no eviction of live coordination keys; clients must handle capacity errors. No canonical business record lives there.
- Storage binds only S3; no administrative/filer/master web interface is published. Local account is privileged bootstrap credentials for tests; scoped app object credentials and signed upload flows must be added before attachments exist.

## Production gates

This Compose file is development-only; application config refuses production mode. Before deployment: reviewed authentication/bootstrap/MFA/authorization, legal/privacy decisions, external KMS and secret rotation, TLS/CSRF, tenant isolation, field-level identity encryption, encrypted storage and retention/purge, signed external audit checkpoints, private/scoped attachment access, monitored encrypted offsite backups and PITR, restore drills for DB + objects, metrics/security alerts, vulnerability scans and workload-specific load tests. RPO <=15min/RTO <=4h are targets, not current guarantees.
