# Private task reports

The first attachment slice adds **Completion reports** to task details in the existing web console. It accepts UTF-8 `.txt` reports from 1 byte to 64 KiB; whitespace-only, malformed UTF-8 and non-text control bytes are rejected. Reports remain text-only. Migration 25 separately enables [shared photos and PDFs](WORK_MATERIALS.md) for task instructions, with broader task-reader disclosure and content reconstruction. Arbitrary documents, previews and malware scanning are not implemented. Text is downloaded as an attachment, never rendered as HTML. Uploading a report does not submit or verify work, change progress, or award contribution points.

## Authority and disclosure

Migration 22 owns `ertad.work_evidence`. Current session, organization, frozen task ancestry and Work permissions are checked in the database on every operation and again after storage/audit operations. Runtime credentials cannot read or mutate its table directly. A task manager or current verifier can read reports within their task scope; a current contributor can read only their own reports. Generic task visibility alone is insufficient. Uploads require an open task and current manager authority or an active assigned/in-progress contribution. Closing a task disables uploads. Moving a unit out of its original ancestry denies inherited access.

Lists return opaque report IDs, byte counts, dates and an own-report flag. They omit original filenames, storage paths, content hashes, uploader identifiers and file bodies. Reports may contain sensitive operational information: users must avoid identity or biometric material. Hierarchical task authority does not grant general access to identity data.

## Publication, download and retention

The server reserves a durable pending record before writing to the private `ertad-attachments` bucket under its own generated `work-evidence/<organization>/<report>.txt` path. Publication becomes ready only after successful storage, transactional audit and a current-authority check. No browser S3 credentials or public/presigned download URL is issued. Identical retries reuse the uploader's request key and bytes; changed content under that key conflicts. Failed publication stays hidden and can be retried or purged.

Downloads require current authority, valid retention, matching SHA-256 and byte count, valid UTF-8 and a committed audit entry before releasing bytes. Responses use no-store, attachment disposition, nosniff and a restrictive CSP. Logs and audit omit report content, original filenames, hashes and session credentials.

Pending reservations expire after 15 minutes. Ready reports expire 90 days after their initial reservation; retries never extend this date. Expired reports immediately disappear from lists and downloads. Each task allows at most 10 lifetime reservations per uploader and 100 in total, including failed/purged reservations. These conservative initial limits prevent unbounded retry metadata; changing policy requires a reviewed migration.

`npm run evidence:purge` physically deletes expired objects in batches of 25 (library maximum 100) and records minimal purge audits. Storage failures leave records retryable. If deletion succeeds but audit/commit fails, a repeat deletion is safe. Metadata remains for idempotency and audit. Cleanup and publication use the same transaction lock; neither scans nor deletes unrelated bucket objects. **Expiry enforcement is automatic; physical cleanup currently requires this operator command.** See [operations](../OPERATIONS.md#private-task-report-retention).

## Operational and release limits

The existing development data services are reused without additional ports. Local API storage uses `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `ERTAD_STORAGE_PORT`; the optional `ERTAD_EVIDENCE_ENDPOINT` overrides the endpoint for container routing. Existing local S3 credentials are broad development credentials. Production needs bucket/prefix-scoped application and cleanup credentials, transport/encryption configuration, a monitored cleanup schedule with backlog alerts, reviewed retention policy and the existing MFA/privacy/release gates. No production activation is authorized or enabled by this feature.

The small synchronous uploads use a bounded storage timeout and a shared transaction lock. This favors consistent publication at development scale; throughput is not benchmarked. Adding richer formats requires quarantine, content inspection and a tested release policy before enabling them. This slice does not claim general safe-document scanning, automatic physical retention cleanup, mobile attachment support or full V1 completion.

`npm run test:work-evidence` runs disposable-database/storage boundary scenarios; `npm run test:work-evidence:browser` additionally exercises participant upload, manager download, sibling isolation, languages, themes and responsive layouts. Fixtures contain synthetic report text only. Actual verification results belong in [status](../STATUS.md).
