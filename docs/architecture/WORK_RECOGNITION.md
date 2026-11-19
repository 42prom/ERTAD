# Recognition for verified work

Migration 28 adds contextual **Additional recognition** to task detail. It reuses immutable Activity, collective proposals, independently approved manual rules and the Contribution ledger. No directory, separate points engine or account grants are added.

A current task manager/verifier with collective proposal and contribution-award authority can select another currently scoped, verified participant. Selection comes from that task's verified Activity; no recipient identifier must be typed. Synthetic demo labels remain fixture-only. Other accounts use the existing opaque member label until private profile/display-name contracts are delivered. The panel shows available, awaiting-approval and already-awarded states; missing manual policy is explained with a link to Contribution.

An additional bonus is separate from the task/event's automatic offer. Its amount must fit the current approved manual rule. A reason and independent eligible reviewers are required; proposer and beneficiary cannot approve. Existing governance thresholds and gross member/issuer monthly limits apply. The UI proposes a seven-day review window. Existing standalone manual awards remain available for other contributions.

The optional `activityId` on `points_award` is validated against organization, beneficiary, exact unit, verified assignment and current proposer Work authority. It is rechecked at proposal, application and post-audit finalization. Current manual-policy version is required: a changed/disabled rule blocks stale approval. Reads re-evaluate after audit and use `Cache-Control: no-store`.

At most one pending unexpired or approved linked bonus exists per Activity. Organization serialization protects concurrent requests; UUID comparisons are canonical and an approved-source unique index is additional defense. Exact retries preserve the original receipt. Withdrawal, rejection or expiration permits a new proposal. A compensating correction does not reopen an already approved source. This is per verified task participation, not automatic detection of repeated real-world events or unrelated standalone manual awards.

Review and private points history show the verified-task source. The title is returned only with current Work visibility; otherwise the UI shows a restricted-record label. Corrections retain that source through the original immutable award. No notification payload adds titles, participant identities, reasons or balances.

Validation: `npm run test:work-recognition` uses a disposable database for hierarchy/tenant isolation, source forgery, self-awards, policy bounds, concurrent exact retries, source duplicates including UUID casing, audit rollback, correction retention, withdrawal, stale rules, title privacy, authority expiry during audit and HTTP/CSRF/schema boundaries. `npm run test:work-recognition:browser` exercises proposal, independent approval, beneficiary history and sibling exclusion through Chrome and the local Vite UI. UI unit tests cover scoped selection, immutable uncertain retries, disabled authority/policy and conflict refresh.

Deferred: role-specific stacking, a unified automatic/manual/pending timeline, privacy-safe member discovery, broader non-task source linking and production release gates. These are not prerequisites for this bounded contextual bonus flow.
