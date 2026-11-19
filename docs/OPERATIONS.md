# Local operations

## Technical web-account protection

After migrations 55–62, explicitly upgrade the existing local technical operator with `npm run platform:bootstrap -- --accounts` and the independent reviewer with `npm run platform:bootstrap -- --reviewer --accounts`. These commands preserve passwords, grant expiry and revocation (granting `platform.accounts.propose` to the operator and `platform.accounts.approve` to the reviewer alongside `.read`/`.hold`/`.release`). Open **Technical management → Web account protection**. The **Web sessions → Protect account** link opens the exact organizational account when both read capabilities are present; alternatively search by its opaque account reference.

**Pause web access** requires a security reason, explicit confirmation and the operator's current password. It closes all web sessions, blocks new login and invalidates unused recovery/email-change proofs. Organizational memberships and permissions are unchanged. Only accounts with an established eligible personal recovery path can be paused in this slice; technical/bootstrap/provisioned-MFA and existing Quick Login accounts remain protected.

**Governed account lifecycle actions (Migration 58):** Under **Web account protection**, an operator with `platform.accounts.propose` can propose `disable_account`, `restore_account`, `lost_contact_recovery` (with validated replacement email), or `mfa_reset` with reason, intent and current password confirmation; a different reviewer with `platform.accounts.approve` approves/rejects (or the proposer withdraws) before any state change applies. Approved actions (except `restore_account`) close all sessions and invalidate pending recovery/email-change proofs without touching organizational memberships.

**Events, Decisions, Operational Reports & Inbox Reminders (Migrations 59–61):**
- **Events:** Open **Events** to edit/reschedule an open event with an explicit audit reason and immutable history; cancelling an open event with unverified open/offered linked tasks requires ticking **Cancel linked tasks** (completed tasks and earned participation claims stay preserved).
- **Decisions (Migrations 60 & 62):** System administrators control the global minimum anonymous electorate threshold (`anonymousMinElectorate`, `2–1000`, default `10`) under **Technical management → Security limits** via dual approval (`platform.limits.propose` + `.approve`). Organizational managers with `decision.manage` can select multiple authorized units (`includedUnitIds`/`excludedUnitIds`), inspect live electorate estimates, schedule future `opensAt` openings (`Scheduled` tab), customize referendum labels, nominate/withdraw candidates on drafts, mark `binding_review` (still non-executing: manual governance workflows apply), enable unlinkable `anonymous` voting (optionally raising the poll floor above the system minimum, pinned on publication), and export bounded (250-row) aggregate CSV reports via **Export report**.
- **Tasks & Inbox:** Managers see **Due soon (< 48h)** and **Resource shortfalls** filters/badges on **Tasks** and can export bounded aggregate CSV reports; **Inbox** includes `'event'` source notifications and 48-hour reminders with explicit read acknowledgement.

The owner requests a new link on **Recover password** using the existing bound contact and chooses a new password. The hold still blocks login. A different technical manager then refreshes the panel and uses **Release hold**, confirming with their own password. Old sessions stay revoked; the owner signs in normally. This does not clear account lockout, activate an inactive account, reset MFA or restore organizational access. Operators cannot redirect recovery or choose the owner's password. No automatic incident notification is currently sent; the existing recovery channel and known support channel remain necessary.

Run `npm run test:account-security` for disposable integration verification and `npm run test:account-security:browser` for the local Chrome journey. Real provider/domain acceptance and the remaining lifecycle gates are tracked in [the security contract](architecture/WEB_ACCOUNT_SECURITY.md) and [web completion checklist](architecture/WEB_PHASE1.md).

## Change your verified sign-in email

Open **Account security → Sign-in email → Change sign-in email**. Enter the new address, confirm intent and your current password. Your old address remains active until you open the new-address email link while signed in to the same account, then confirm again with your password. Opening a link while signed out displays sign-in instructions; sign in and reopen the original email. Completion closes every session. Sign in with the new address and existing password; password recovery now uses that address. The old address receives a non-action security notice.

Use **Cancel email request** with your current password to abandon a wrong or expired pending request before creating a replacement. Delivery status distinguishes awaiting processing, provider acceptance, stopped and uncertain outcomes; acceptance is not inbox-delivery confirmation. An uncertain operation is never retried automatically: refresh state or sign in normally to establish the result. Creation is limited to three requests per account/hour. Technical managers configure and independently review the delivery service separately; they cannot change another account's address through this screen.

This flow requires an activated account with a verified real contact and enabled email delivery for new requests. Synthetic/bootstrap/unbound accounts display an unavailable explanation; existing development Quick Login is preserved. No real provider or domain acceptance is implied by local tests. Run `npm run test:email-change`; the optional `npm run test:email-change:browser` uses Chrome, synthetic recipients and a disposable database. The browser runner accepts `ERTAD_BROWSER_WEB_ORIGIN` for a stable local preview; it does not start a tunnel or deploy the application. See [the full safety contract](architecture/MAIL_POLICY.md#personal-sign-in-email-change-migration-54).

## Configure recipient security email

To correct an unactivated recipient address, select that recipient on **Web invitations**, then use **Revoke recipient contact** and confirm intent/password. Old invitations and links become unavailable; queued tokens are purged. Add the same member with the correct address and create a new invitation for independent approval. This cannot edit or revoke an already activated account's contact. See [pending-contact rules](architecture/MAIL_POLICY.md#pending-contact-correction-migration-53).

In **Technical management → Email service**, propose the sender name/email, SendGrid API credential or a supported SMTP service/username/password, and the public ERTAD HTTPS origin. SMTP supports SendGrid, Google/Gmail and Microsoft 365 with required STARTTLS; use authentication allowed by that provider. Arbitrary SMTP hosts are not enabled. Keep credentials in the encrypted panel, never in chat, screenshots or Git.

A second technical manager with current approval authority approves the proposal. **Validate without sending** checks SMTP authentication or SendGrid sandbox validation; it does not establish sender-domain ownership or inbox delivery. **Enable real email delivery** separately opts in to the API's durable worker. The approved public origin must reach this ERTAD web application; provider/domain setup and live delivery acceptance are operator prerequisites. Development does not automatically start an external tunnel.

Organizational managers use **Web invitations → Add member email**, confirm the member-supplied destination and consent with their password, then submit an invitation for independent review. The recipient explicitly confirms the first email link, receives a separate activation link and chooses their own password. Opening a link performs no action. Recovery then uses that verified bound contact. See [mail behavior and failure handling](architecture/MAIL_POLICY.md#external-security-delivery-migrations-5152).

The API process checks the queue every 15 seconds. Technical management shows aggregate states; organizational managers see only their scoped invitation states. Provider acceptance does not confirm inbox delivery. A network/commit ambiguity becomes uncertain and is not automatically resent. Do not manually reset sending/uncertain rows or rotate their token to force a retry; revoke/reissue an eligible invitation through the normal approval flow. Existing recovery requests expire within their original 30-minute limit.

## Local web invitations

Migration 47 enables the development invitation journey. `npm run demo:invitations` adds scoped invitation permissions to the existing six synthetic accounts and two unlinked synthetic recipients, one per region. It preserves existing passwords and requests; rerunning does not reset the fixture. Quick Login remains available.

1. Sign in with an organizational demo account and open **Web invitations** in the sidebar. Select a visible recipient, enter a reason and deadline, and explicitly confirm creation.
2. Sign in as a different currently authorized administrator and approve the invitation in **Requests**. Approval must meet the displayed review requirement. It does not create an account or appoint a leader.
3. From the repository root run `npm run invitations:mailbox`. It writes synthetic messages into the ignored `.local/invitation-mailbox` directory; no external email is sent. The command prints counts, not links or credentials.
4. Privately open the message's local activation URL in a separate signed-out browser session. Enter and repeat a new password, then confirm activation. Use normal login with the synthetic recipient email and chosen password afterward. Opening the link alone does nothing.
5. The issuer can revoke an unused invitation from its list. Expired, revoked or already consumed credentials cannot activate again. Recipient access comes only from existing active memberships; the activation itself grants no additional authority.

Local mailbox files contain credentials and must stay private and ignored. Links use `http://localhost:15173` (or `ERTAD_WEB_PORT`) and are for the developer's machine, not remote tunnel delivery. A delivered link expires within 24 hours and no later than its contact/request deadline. No real contact ownership or identity verification is established by this fixture.

If delivery reports failure and a `.json.pending` file exists, preserve it. An uncertain database commit or final file publication can leave the token committed while that private message is still pending. Confirm the invitation's database delivery/expiry/revocation state before using or publishing that same message; do not blindly delete, overwrite or regenerate it. If validity cannot be established, explicitly revoke the invitation and issue a new reviewed request. The command does not automatically resolve uncertain delivery.

Run `npm run test:invitations` for isolated SQL/API and mailbox scenarios; `npm run test:invitations:browser` additionally needs local Vite and Chrome and uses a disposable API/database. See [verified status](STATUS.md) for executed evidence. Real recipient delivery, contact verification, recovery and production MFA remain separate work.

## Local recipient password recovery

For a synthetic recipient who has already activated an account through **Web invitations**:

1. Open **Forgot password?** on the login page, or `/recover`, and enter the account's existing email. The acknowledgement is intentionally identical for available and unavailable accounts.
2. Run `npm run recovery:mailbox` from the repository root. Privately open the link in the corresponding ignored `.local/recovery-mailbox/<id>.json` file. No external email is sent; the file is a credential.
3. Enter and repeat a new password and explicitly confirm closing old sessions. After completion, sign in normally with the new password. Other browser sessions must sign in again.

The link expires at most 30 minutes after the request, even if delivery is delayed. Repeated requests preserve an existing valid link and its original expiry; after expiry a new request can be created. A password change in the meantime invalidates the old link. Account suspension/lockout, inactive member, revoked/expired contact, changed email, provisioned MFA or technical classification make this recovery path unavailable. It does not restore permissions or reset MFA.

Existing six-account Quick Login credentials are preserved and are not part of this recipient recovery fixture. Losing contact access or a second factor requires a separate recovery process that is not implemented by this slice. Real contact validation and external delivery remain unfinished.

The mailbox uses the same exclusive publication and `.pending` reconciliation rules as invitations. Preserve an uncertain pending message; confirm its committed database state and expiry before using the same message. Do not blindly overwrite or regenerate a token. If its validity cannot be established, leave it unused until expiry and request a fresh link. Do not publish mailbox files or URLs in logs, screenshots or Git.

## Security monitoring

Open **System administration → Security monitoring** with an existing technical account that has both `platform.read` and `platform.audit.read`. No bootstrap upgrade or migration is required for this view. Select 15/60 minutes and an event category; the panel shows completed API-response counts and separately the latest sanitized technical authentication audit entries. The parent refreshes on focus/every sixty seconds, or use **Refresh**.

These counters belong to one API process and reset on restart/hot reload. Check the displayed observation start before interpreting zero counts. The durable audit is separate. **Review sessions** opens the existing response controls only with session-read permission; termination still requires its own grant, reason and password confirmation. Aggregate counts do not identify an attacker or a particular session. Country/IP rules and verified tunnel attribution are available separately under **Network protection**; external provider intelligence is still inactive. See [monitoring coverage and limits](architecture/MONITORING.md).

Run commands from the repository root. Compose project is fixed to `ertad`; do not operate on unrelated projects or prune Docker globally.

## Starting and stopping development

Open Docker Desktop and wait for **Engine running**. Run `npm run infra:up`, then `npm run dev`, keeping the dev terminal open. The first command checks only the PostgreSQL/Redis/storage ports and preserves existing ERTAD services/data. It can run while host API/web are already running. Full container startup remains `npm run stack:up`, whose preflight additionally checks the apps-profile ports.

The development runner checks API/web ports before spawning children and prints a useful conflict instead of killing an existing process. It waits for the API and same-origin web proxy to become ready before launching Cloudflare. With `ERTAD_TUNNEL=true`, the existing ignored `infra/cloudflared.yml` and credentials file are required. The configured tunnel URL is printed at startup. Quick login is unchanged by these startup fixes. Tunnel, API and web are a single runner lifecycle; an unexpected child exit stops the others.

Use `Ctrl+C` in the dev terminal, or `npm run dev:stop` from another terminal at the same checkout. A local named pipe (Windows) or private Unix socket addresses only that runner; no TCP control port or broad process-name kill is used. Repeating stop when no managed runner exists is harmless. Individually launched `dev:api`/`dev:web` terminals are separate and must be stopped in their own terminals. After a crash on Unix, a stale `.local/dev-control.sock` may require removing that socket after confirming the runner is absent.

To stop Docker data services too, run `npm run infra:down` after stopping the dev runner. Volumes remain; do not add `-v`. Start again with `infra:up` then `dev`. After code changes that add migrations, run `npm run db:migrate` between those commands. Existing accounts/credentials/domain data need no bootstrap/reset on ordinary restarts.

If PowerShell refuses `npm.ps1`, use `npm.cmd run ...`. If Docker Engine is unavailable, start Docker Desktop first. If readiness fails, check data-service health and pending migrations; the runner exits after a bounded startup wait instead of exposing an unavailable application through the tunnel. Keep prompts, `.env`, tunnel credentials/config and local diagnostics ignored.

## Membership transfer and termination

Open **Members**, search for the person and open their card. **Manage membership** appears separately beside each membership you can manage. Choose **Transfer / change position**, select an existing approved destination and expiry, or choose **End this membership**. Enter a reason and explicitly confirm the request. Another eligible administrator decides in **Requests → Needs my decision** or through the unified inbox. The web request expires after 24 hours.

Both proposer and reviewer must have their respective change permissions and member/unit visibility at both ends. A regional administrator cannot transfer someone into another region without that scope. Cross-region requests normally need two eligible council accounts. The requester and subject cannot approve. The selected membership ends only after approval; other memberships remain active. Points, completed work and identity records are retained. Active task responsibilities block the operation and must first be resolved through Tasks.

Use the **Ended** membership-status filter to inspect retained history. A lower visible points total after transfer can reflect scope changes, not lost awards. This does not suspend the login account or revoke every role at once. Migration 39 is already applied locally and needs no demo reseeding. Run `npm run test:members:lifecycle` or `npm run test:members:lifecycle:browser` against disposable fixtures. See [the lifecycle contract](architecture/MEMBERSHIP_LIFECYCLE.md).

## Personal web account security

Open **Account security** in the sidebar account area, or `/account`. An authenticated user can inspect their own active web sessions without organizational or technical grants. Select another session, enter the current password and confirm to revoke it. Use ordinary logout for the current session.

Use **Close all other sessions** to end all your other web sessions at once, including those on other list pages. Enter the current password and explicitly confirm; the session you are using remains active. This does not prevent a subsequent sign-in. If somebody else knows your password, change it as well. An uncertain response refreshes the list without automatically repeating the action; inspect the result before confirming again, because a later confirmation also affects newly created sessions.

To change a password, enter the current password, a new password and its confirmation, then explicitly confirm. The existing policy requires at least 14 characters and at most 72 UTF-8 bytes; an unchanged or email-derived password is rejected. Success ends every session for that account. Sign in normally with the new password. Uncertain results are not automatically retried; establish the current state through login. This operation never changes memberships or permissions.

Synthetic quick login uses its existing local fixture credentials. Changing a fixture account's password does not rewrite those stored credentials; use normal login with the new password. Never reset existing accounts merely to restore a quick-login demonstration. Migration 45 itself changes no passwords or sessions.

Migration 46 adds an honest pending-MFA state for future accounts. Newly bootstrapped local accounts still use email/password, but no unused authenticator secret is generated or recorded as enrolled. Existing local credentials and account states are preserved. Password-only sign-in does not enable MFA. Production remains gated and requires a separate accepted enrollment journey; this change does not enable administrator invitations or MFA recovery.

See [web account boundaries](architecture/WEB_ACCOUNTS.md). `npm run test:account` and `npm run test:account:browser` use disposable synthetic accounts, not the developer's existing accounts. Administrator invitations and group QR onboarding remain separate work under [INVITATIONS](architecture/INVITATIONS.md).

## Controlled adoption of position revisions

For moving members to an approved position revision, use **Positions and permissions → revised position → Adopt revision / progress**. Compare added/removed permissions, search and select up to 20 eligible memberships on the current page, enter a reason and confirm. Each selected membership produces its own request; another authorized administrator reviews it in **Requests**, where the same permission comparison and unchanged expiry are shown. The progress view reports pending, approved, rejected and expired requests per member. Partial submission is shown explicitly: retry the unchanged uncertain remainder, or refresh and reselect after a definitive conflict. Resolve listed work responsibilities or pending changes before attempting adoption. Existing suspended status and original start/expiry are preserved. See the [controlled-adoption contract](architecture/POSITIONS.md#controlled-adoption-of-an-approved-revision).

## Membership suspension and restoration

After migration 42, open **Members → member card → Manage membership** and choose **Suspend this membership**. Enter a reason and confirm; a different authorized administrator approves in **Requests**. This restricts only the selected membership after approval. It preserves other memberships, current assignments, earned points and history. Resolve remaining work through normal manager controls; it is not silently reassigned or marked completed.

To restore access, set the member list's **Membership status** filter to **Suspended**, reopen the card and choose **Resume this membership**. Another administrator must approve. The original position and expiry remain unchanged; an expired membership, retired definition, unavailable bundle or overlapping active assignment to that position prevents restoration. A future-start membership remains scheduled after restoration. There is no automatic timed restoration or account-wide lockout in this journey. Ending a suspended membership is also possible when its current term and responsibility checks permit it.

Migration grants no new permissions and requires no demo reset. Run `npm run test:members:suspension:browser` for the isolated Chrome journey; the normal local web server must be running. See [the membership contract](architecture/MEMBERSHIP_LIFECYCLE.md).

## Group and region lifecycle

After migration 38, use **Groups and regions** (`/units`) to propose **Rename** or **Archive** on an eligible row. Another authorized administrator reviews it under **Needs my decision**, enters a reason and confirms the change. Submission alone does not change the unit. Council authority governs regions; regional authority governs child groups. The organization root is excluded. The unified inbox also exposes pending changes to eligible reviewers.

**Archive** is deliberately limited to empty units. The row explains blocking categories such as members, positions, child units or operational records; completed records also block archival. No cascade deletion or automatic membership revocation occurs. Select **Archived** to find an archived unit and propose **Restore**, which also requires independent approval and retains the same unit ID and history. A conflicting name, stale unit version, expired request or lost authority prevents approval.

For the existing six synthetic accounts, `npm run demo:unit-changes` adds explicit, bounded lifecycle grants without changing credentials or previous requests. It does not reactivate revoked or expired grants. This upgrade is already applied to this local checkout; ordinary restarts need no reseeding. Use one regional account to propose a change and the second account in the same region to approve. These are development fixtures, not production authorization provisioning.

Run `npm run test:units` for disposable SQL/HTTP coverage and `npm run test:units:lifecycle:browser` for the Chrome rename/archive/restore journey. The browser test pauses between account phases to honor existing API limits. See [hierarchy lifecycle](architecture/HIERARCHY.md) for the permission and historical-access contract.

## Unified inbox

Migration `0015_unified_inbox.sql` adds `/inbox` and the global unread bell; current API readiness requires all twenty-eight migrations. No demo upgrade, new permission bundle or credential reset is needed: existing scoped membership, unit, Work and collective grants determine the queue. Use **Needs my action**, **Unread**, **All** and category filters; open a row to act in its original module. **Mark as read** never approves a request, and a later change becomes unread again. See [Communication](architecture/COMMUNICATION.md) for recipient selection and disclosure boundaries.

Run `npm run test:inbox` for disposable database/HTTP checks, or `npm run test:inbox:browser` with local Vite and Chrome for the complete browser journey. The browser test intentionally pauses between batches to honor unchanged rate limits. It creates no live business records. Channels, discussion and external delivery are not enabled by this migration.

## Mobilization and reward templates

With current root contribution-policy authority, open **Contribution → Add reward template**, enter its name, allowed unit/subtree, amount and caps, and submit the reasoned proposal. Another eligible administrator approves it in **Approvals**. Task creators then choose the offer in **Tasks → New task → Participation reward**, or leave **No reward**. Optional meeting place/start time are available; advanced role/priority settings are collapsed. Members volunteer, receive an assignment, start work and submit completion; an independent current verifier confirms or returns it. Confirmed eligible work issues points once through the existing Activity transaction, and the beneficiary sees the template title in private history.

Template changes are prospective. Delegation preserves the parent's offer. One task has one offer; it does not assign different amounts per person/role. Monthly task caps aggregate gross task awards across templates and versions. No new demo seed or grants are required, and no award amounts are populated automatically in existing organizations. `npm run test:mobilization` checks the focused disposable-database cases; `npm run test:mobilization:browser` adds the eight-stage Chrome journey. These cases also run within `npm run test:work`. See [Contribution](architecture/CONTRIBUTION.md) for scope, correction and privacy rules.

## Events

After migration 27, open **Events → Create event** to set its unit, title, instructions, time/place and approved automatic offer or no reward. **Add task** creates a normal task and opens its existing participation/management screen. Delegations retain the same event. The shared event context is visible to current event-unit readers and readers of its delegated tasks; only currently readable tasks are listed. Keep private instructions in the relevant task.

One event is one automatic reward occurrence per member. All linked tasks share the pinned offer; the first independently verified completion claims it. Further completions retain Activity without extra points, even after a correction or exhausted cap. Old standalone tasks/history are unchanged. Close linked tasks before completing/cancelling the event; closure preserves earned history. There is no retrospective linking, rescheduling or reminder delivery in this slice. No account reset or new grant bundle is required. See [Events](architecture/EVENTS.md); run `npm run test:events` or `npm run test:events:browser` against isolated data.

## Completion review hierarchy

After migration 26, **Tasks → task → Participants and progress** explains the required confirmation level for each participant. Ordinary participants can be confirmed by an independent authorized reviewer at the task's unit. A manager's own participation requires authority at the parent of their highest management unit for that task. At the root, another eligible root reviewer must act. In the six-account demo, one regional administrator can assign another, but their completion goes to an eligible council administrator rather than a regional peer.

**Inbox → Needs my action** and **Verify completion / Return for changes** use this same rule. Existing pending submissions adopt the rule; completed work and earned points are not recalculated. A stored review floor cannot be lowered by resigning management authority. Current permissions, task ancestry, qualification gates and final audit checks still apply. If no eligible reviewer exists, leave the work pending and use the existing governed appointment process; there is no automatic permission grant or self-review fallback. No account reseed is needed. See [WORK_REVIEW](architecture/WORK_REVIEW.md); run `npm run test:work-review` and `npm run test:work-review:browser` for isolated checks.

## Shared task links

Open a task and choose **Task materials → Manage links** to add, edit or remove up to ten HTTP(S) links, then **Save materials**. Current scoped managers can edit open/offered tasks; everyone currently authorized to read that task can see its links. Closed tasks retain a read-only list. External pages open without previews in a separate tab. Their access policy belongs to the destination. Private **Completion reports** retain their narrower author/reviewer access.

After an uncertain save use **Retry request**; the original payload/key is preserved. A conflicting version requires reopening the task before editing again. Link changes enter existing scoped Work history/notifications without including URLs and do not award points. Migration 24 requires no account reseed. See [WORK_MATERIALS](architecture/WORK_MATERIALS.md) for disclosure and file-format limits. Run `npm run test:work-materials` or `npm run test:work-materials:browser` for its isolated checks.

## Shared task photos and documents

Open **Tasks → task details → Photos and documents**. Current managers can select PNG/JPEG or PDF up to 5 MiB and choose **Upload file** on open/offered tasks. PDFs are limited to five pages and become image-only documents; forms, selectable text, interactive links and signatures are not preserved. Photos lose original metadata. All current readers of the task may download these shared instructions; personal completion reports retain their separate disclosure. Unsupported or malformed content is rejected. If processing is busy or the outcome is uncertain, use **Retry same upload** with the retained file/key.

Managers can confirm **Remove file** to stop further downloads immediately, including on closed tasks. Files expire after 90 days and failed pending uploads after 15 minutes. Run `npm run evidence:purge` for physical deletion; there is no background cleanup schedule yet. Lifetime reservation quotas remain ten per uploader/task and 25 per task. Original filenames are not stored. Apply migration 25 with the normal local migration command; do not reseed accounts. Run `npm run test:work-files`, `npm run test:work-files:browser` and the existing report regression suite. See [WORK_MATERIALS](architecture/WORK_MATERIALS.md) for processing bounds and production limitations.

## Channel moderation notices

Migration `0020_moderation_inbox.sql` connects existing channel restrictions and appeals to the same inbox/bell. In **Incoming requests**, choose **Channel moderation**: affected members can open their restriction and appeal; eligible independent reviewers see **Review appeal** under **Needs my action**. **All** retains currently authorized resolved records. Opening a notice retrieves that exact record, even outside the channel queue's current page. Marking it read changes neither the restriction nor its appeal. Message text, reasons and participant identities stay out of previews.

Current channel permissions, hierarchy and task participation govern both the notice and its destination. No new grant, account reseed or password reset is required. If another administrator changes a record, the existing focus/60-second inbox refresh picks it up; this is not external push delivery.

Run `npm run test:moderation-inbox` for isolated database/HTTP authorization and lifecycle checks. With local Vite on 15173 and Chrome available, `npm run test:moderation-inbox:browser` additionally exercises issuer, affected member, independent reviewer and sibling-region isolation. It pauses between account and layout batches to honor unchanged rate limits, so allow several minutes. Fixtures live in a disposable synthetic database; the test does not modify live channel records.

## Work operations, funding and recognition

Migration 21 adds **Contribution and recognition** in the shared inbox. Approved awards, corrections and cap-reached outcomes appear only for the beneficiary. Use **Unread** or **All**, then **View** to open the exact private ledger entry; **My full history** returns to the normal history. Reading does not change points. Issuers/reviewers continue to use administrative approvals. No live account upgrade, reward-rule seed or credential reset is needed. Run `npm run test:contribution-inbox` for disposable database checks, or `npm run test:contribution-inbox:browser` with local Vite/Chrome for the paced complete browser journey.

After migrations 12–14, run `npm run demo:operations` to add bounded qualification, collective-review, finance and contribution grants to the existing six synthetic accounts. The command preserves passwords, memberships and existing work; it does not configure any reward amount or invent received money. API/web continue locally on 13000/15173. No production migration or payment provider is involved.

In **Tasks**, open a task and use **Add need** before participation or delegation begins. Configure people roles, resource/service quantities, owner, deadline and optional/start/completion gates. Qualifications require a claim and a different authorized verifier. Delegating a people role carries its qualification requirements and quota into the child task; partial acceptance returns capacity. Resource/service offers remain pledges until independently confirmed; returns restore the remaining gap.

The task's **Funding and expenses** panel proposes a currency-specific budget. A second administrator opens **Approvals**, reviews the parameters and reason, and records an approval or rejection. Only an approved budget enables pledges and receipts. Receipts record externally received money with a non-sensitive reference; an optional pledge reference links partial fulfillment. Expenses, reservations, reservation conversion/release, refunds and reversals follow the same independent review. Child envelopes allocate existing money once; they do not create revenue. Payment collection, bank-account data and file evidence are not part of this flow.

**Approvals** has pending/own/inbox/history views, a fixed independent reviewer cohort, quorum progress, written decisions and explicit mark-read. Changing a unit's approval policy uses its current policy. Author/beneficiary cannot approve their own proposal. Root authority does not replace the requirement for eligible administrators in the proposal's unit. Fixed one independent reviewer is the default; majority, two-thirds, unanimity and a larger fixed threshold are configurable.

In **Contribution**, a council administrator proposes a task/vote/survey/manual rule; another eligible council administrator approves it. Existing tasks and open Decisions keep their pinned rule. Accepted participation awards once, with gross monthly caps; manual recognition requires a scoped proposal and independent approval. Corrections append a reversal instead of editing history. Points cannot be exchanged, transferred or used as permissions. No rule is automatically enabled in the local demo.

Member financial summaries require explicit publication, ten net-positive contributors, ten contributors new to the prior published cohort and a 24-hour publication interval. They are dated snapshots, not live donor records; controllers retain current scoped accounting. Combined cross-domain notification delivery/reporting, secure attachments and mobile use remain separate work.

`npm run test:work` exercises the real database with disposable synthetic fixtures. `npm run test:operations:browser` uses real Chrome and the running local Vite host with a disposable API/database; it does not populate live demo data.

## Development and checks

`npm run setup` preserves existing `.env` and creates credentials only for a new file. `npm run infra:up` checks ports and starts only PostgreSQL/Redis/S3. `npm run db:migrate` runs owner-authenticated migration separately from the runtime API; checksum drift aborts, and advisory lock serializes migrators. `npm run dev` starts local API and Vite with reload.

`npm run smoke` requires the API and web running. `npm run test:integration` verifies database privilege separation, exact applied migrations/checksums, authenticated Redis, private S3 object roundtrip and anonymous denial, followed by authentication and scoped-access suites. `npm run test:auth` creates a new random `ertad_auth_test_*` database, applies only foundation migrations and uses synthetic credentials to test MFA/replay, sessions, CSRF, lockout, revocation and audit failures. It removes only its own database and never changes the developer's account. The intentional audit-permission failure prints a sanitized database error during this passing suite.

`npm run test:scope` creates and removes its own `ertad_scope_test_*` database on ERTAD's PostgreSQL. It runs the real foundation migration runner twice, then verifies scoped reads, tenant constraints, restricted authority writes, bundle immutability, real revocation/hierarchy races, expiry during audit and audit-chain integrity. Fixture identities and grants exist only in this disposable database. Migration `0003_scoped_membership.sql` creates empty authority tables in the development database; it does not link the local administrator to a member, create an organization or grant permissions. The new review route separately checks current persisted scope; legacy product routes remain disabled. Run `npm run db:migrate` after updating the local checkout; never edit checksums or already-applied migrations.

`npm run restore:drill` exports a repeatable-read snapshot, restores a dump of that snapshot into a fresh randomly named scratch database, and compares every ERTAD table (including migration checksums), runtime table privileges/RLS and function execution/security attributes. It verifies a protected audit write is rejected and a deliberate checksum change in the disposable clone is detected and rolled back. Only its own temporary database/dump is removed; the live database remains online and unchanged. No record contents or credentials are printed. The sorted per-table fingerprints are intended for this local dataset, not a large production backup benchmark. This does not test production RPO/RTO, PITR, attachment objects or encryption-key recovery.

`npm run test:bootstrap` adds twenty offline governance-bootstrap scenarios in disposable `ertad_bootstrap_test_*` databases; the full integration command includes it. Foundation migration `0004_governance_bootstrap.sql` creates an empty installation latch/history and adds the explicit membership proposal/approval permission names. It does not arm bootstrap or create authority. The [offline installer](architecture/BOOTSTRAP.md) requires a dedicated owner process, two nominated web accounts with independent fresh password step-up, and explicit bootstrap mode. Do not put `ERTAD_BOOTSTRAP_MODE=true` into the API environment: startup rejects it. The current development installation remains unarmed. Migration `0005_membership_reviews.sql` adds the first recurring membership/position request, independent decision and in-app notification tables. See the [implemented review boundary](architecture/APPROVALS.md). `npm run test:reviews` covers 18 disposable DB/HTTP scenarios; add `-- --browser` while Vite is running for two real Chrome sessions against the disposable API. The production-bootstrap latch remains unarmed. The separately authorized local web demo below seeds scoped synthetic memberships; migrations alone grant no authority. API readiness requires all fifteen foundation migrations when local authentication is enabled.

If API readiness is 503, verify `docker compose ps`, then `npm run db:migrate`; liveness only indicates the API process is alive. All three dependencies are mandatory for foundation readiness. Secrets are not printed by setup or normal checks. Avoid sharing `docker compose config` or full inspect output because resolved environment includes credentials.

`npm run preflight` intentionally fails when planned app ports are occupied by host processes; stop the existing development runner before using it to launch a second environment. It recognizes this project's running container ports and detects stopped foreign container reservations. Bind is ultimately enforced at actual startup; a preflight cannot eliminate races.

## Lifecycle and recovery

### Local administrator access

After migrations, run `npm run admin:bootstrap`, then start or restart `npm run dev`. Open `http://localhost:15173/login`; the generated email/password are in ignored `.local/ADMIN_ACCESS.md`. No authenticator code is required during development. Bootstrap preserves a matching existing account and never resets credentials automatically. Preserve `.env` and the credential file together: the encryption secret protects stored authentication secrets and CSRF tokens.

Development uses password verification, an HttpOnly/SameSite=Strict server session and Origin/CSRF checks for mutations. Defaults are 15 minutes idle, eight hours absolute and three concurrent sessions. Five failed logins lock the account for 15 minutes; the IP failure budget also lasts 15 minutes. Step-up requires the password. Logout revokes the server session. Password-only composition is rejected outside development/tests, and all production startup remains blocked. The retained strict MFA router is tested separately for missing-code/replay denial; mandatory MFA for every web user remains a production release gate.

Local authentication does not enable the original product APIs or administrator account editor. The original role name supplies menu visibility, never domain authority. Runtime DB grants cannot insert accounts or change their password/role/MFA key, and audit records are append-only. The hash chain is local; signed external checkpoints and production enrollment/authorization are still pending. No password/MFA key is written to logs, tracked fixtures or Git. Generated development credentials live only in the ignored local access files described here.

### Services

- Stop local app terminals with Ctrl+C; `npm run infra:down` preserves volumes.
- To test all containers, stop local apps, `npm run stack:up`, then smoke/browser/integration checks. Return using `docker compose --profile apps stop admin backend`, then `npm run dev`.
- Changing an existing `.env` password does **not** rotate an initialized database or S3 identity automatically. Preserve the file, or explicitly rotate credentials in the services and update clients together. Do not reset volumes to work around authentication on data you need.
- Never use `docker compose down -v` as ordinary cleanup. Record and inspect backups before any intentional local data reset.
- Node/API/admin containers run as non-root with read-only filesystem and dropped capabilities. Database/storage containers retain upstream runtime needs. Docker volumes are persistent, not backups.
- Redis is ephemeral and authenticated. Current policy is no eviction of live coordination keys; clients must handle capacity errors. No canonical business record lives there.
- Storage binds only S3; no administrative/filer/master web interface is published. Local account is privileged bootstrap credentials for tests; scoped app object credentials and signed upload flows must be added before attachments exist.

## Production gates

This Compose file is development-only; application config refuses production mode. Before deployment: reviewed authentication/bootstrap/MFA/authorization, legal/privacy decisions, external KMS and secret rotation, TLS/CSRF, tenant isolation, field-level identity encryption, encrypted storage and retention/purge, signed external audit checkpoints, private/scoped attachment access, monitored encrypted offsite backups and PITR, restore drills for DB + objects, metrics/security alerts, vulnerability scans and workload-specific load tests. RPO <=15min/RTO <=4h are targets, not current guarantees.
## Local web demo

Hierarchy creation additionally requires migration `0006_unit_creation_reviews.sql` and explicit `npm run demo:hierarchy`. This preserves the six accounts and their original reviews, and adds scoped hierarchy grants once. Open `/units`; propose with one regional account and decide with the other. Re-running the upgrade does not restore revoked grants. See [hierarchy contract](architecture/HIERARCHY.md).

The host development environment can provision six synthetic web accounts: two council administrators and two regional administrators in each of regions A/B. Start data dependencies with `npm run infra:up`, run `npm run demo:bootstrap`, then `npm run dev`. At `http://localhost:15173/login`, choose a quick-login button. This feature requires `ERTAD_LOCAL_ADMIN=true` and `ERTAD_WEB_DEMO=true` in the ignored environment file; the bootstrap enables them. Restart the API if it was already running when the flags changed.

Passwords are randomly generated and stored only in ignored `.local/web-demo-access.json` and `.local/WEB_DEMO_ACCOUNTS.md`; they are not returned by the demo API. Standard manual login also remains available. The old local administrator is preserved. Re-running bootstrap preserves existing demo credentials, memberships and review outcomes; it does not replenish expired requests or reset a changed fixture. The demo seed is not production bootstrap or verified identity enrollment.

Council account 1 is the requester for two initial appointment reviews. Council account 2 sees both pending requests. Each region's account 1 is its request's beneficiary and cannot decide it; account 2 can approve/reject its region's request. The other region's detail, lists, counts and fixture people stay unavailable. Open My requests for the requester, Needs my decision for a reviewer, and Notifications for requester/beneficiary after a decision. Demo decisions keep explicit intent/reason and execute normal CSRF/session/password step-up internally without requiring a password to be typed.

The workspace shows permitted units/positions and current pending counts. Use Logout and another login button to switch accounts. Separate browser profiles/incognito contexts are needed for simultaneous independent accounts; tabs in the same browser profile share the session cookie. Pending fixtures expire after six days; initial demo memberships after 90 days. New review requests can be created with the permitted demo-member selector. Workspace, reviews, groups and named polls are active through their explicit domain grants; unrelated imported modules still await their ERTAD contracts.

`npm run test:demo` exercises nine disposable database/HTTP scenarios and is included in integration checks. `npm run test:demo -- --browser` additionally needs host Vite/Chrome and redirects API transport to its disposable database, preserving the user's demo request outcomes. Setting `ERTAD_WEB_DEMO=false` and restarting the API removes quick-login/step-up access. It does not delete the demo accounts or revoke existing sessions; ordinary manual login/session controls still apply. Do not use these identities for real data or production authority.

## Local named polls

Run `npm run db:migrate` and `npm run demo:decisions` to apply foundation migrations and add bounded decision grants to the existing six synthetic accounts. Open `/decisions` from Polls or Manage polls. Regional A account 1 can draft, edit and publish to region A; A account 2 can participate and close; region B cannot read that poll. Council accounts have explicit management grants for both regions. Publishing snapshots eligible participants. Results appear only after closure/deadline, with quorum and tie status. Answers are named and account-linked; this is not anonymous voting. See [poll contract and remaining scope](architecture/POLLS.md).

Migration `0008_decision_formats.sql` extends existing polls with referendums and multi-question surveys; existing records remain polls. Use **Create survey**, **Create referendum** or **Create poll** on `/decisions`; the composer also has a type selector. Referendums use Yes/No/Abstain and a support threshold; surveys support single/multiple choice, text, ratings and ranking. **Add another question** appears beside the question count; each choice question has **Add option**. All three formats use the same hierarchical audience and named-mode disclosure. `/create-poll` opens the composer in survey mode. The election branch and other source-module gaps are tracked in the [restoration plan](architecture/POLLS.md#authoring-restoration-and-remaining-gaps-2026-10-12).

Migration `0009_decision_authoring.sql` adds the option-based **Create election** journey, survey rating endpoint labels and text placeholders. Candidate labels, like survey questions, can be edited only before publication. Expand **Preview** before saving to inspect the participant form; preview controls are disabled and do not cast a vote. Election results show totals/quorum/ties and do not appoint a candidate or grant permissions. Nomination/withdrawal and scheduled opening remain pending.

`npm run test:decisions -- --browser` verifies the poll workflow and the restored referendum/survey/election workflows against a disposable database. `-- --formats-browser` runs the DB/HTTP suite plus only the referendum/survey/election browser scenarios. The ordinary integration command includes all fifteen DB/HTTP decision scenarios. Existing local requests, passwords and polls are preserved.

## Local tasks

Migration `0010_hierarchical_work.sql` installs scoped work and verified Activity. After `npm run db:migrate`, run `npm run demo:work` once to add explicit work grants to the existing six synthetic accounts. Repeating it preserves credentials, task outcomes and deliberate grant revocations. Refresh the console and open **Tasks** (`/tasks`), also linked from the workspace.

To inspect the full journey, council account 1 creates a task in the council unit and delegates places to region A. Region A account 1 opens **Offered**, accepts all or fewer places, volunteers and is assigned a place by a scoped manager. The participant starts work, reports progress with a note and submits completion. Region A account 2 independently verifies it and closes the regional task; council can then close the parent. An account cannot verify its own completion. Region B cannot see region A's task. Direct regional task creation and delegation into that region's group are also available. Group/member permission boundaries are tested with temporary grants in the disposable test database; no additional live mobile accounts are installed.

Use **Inbox** inside Tasks for unread task notifications, **My participation** for applications and **Movement history** for progress/events. Marking read is explicit. Offers, active work, completed and cancelled work have separate filters. Deadlines block new enrollment/allocation but permit late completion. See the [work contract](architecture/WORK.md) for capacity, cancellation and current limitations. `npm run test:work` runs the isolated DB/HTTP suite; append `-- --browser` for the Chrome workflow against host Vite and a disposable API/database.

Migration `0011_work_oversight.sql` adds **Responsibility and oversight**, **Verified outcomes** and **Blockers and next actions** to each task. Set weighted completion criteria before anyone applies or child work is delegated; submit each result with an operational note and have a different authorized manager verify it. The verified percentage is separate from participant-reported progress. A blocker identifies the responsible manager and next review time; **Update blocker** changes the next action/owner/date, while **Resolve blocker** explicitly closes it with a reason. Completion waits for all criteria, blockers, assigned work and child work to be settled. Task-wide result verification does not create personal participation points.

The task list now has scoped overview counters and **Blocked**, **Overdue**, **Needs review** and unit/subtree filters. Existing demo work grants suffice; no new accounts, passwords or authority reset is needed. `npm run test:work -- --oversight-browser` checks coordinator changes, criteria weights, independent results, blocker resolution, queues and responsive themes through Chrome against a disposable database.
## Additional recognition for verified work

Apply migration `0028_work_recognition.sql` with `npm run db:migrate`; no demo reseed, credential reset or additional permission grant is needed. Open **Tasks → a task → Additional recognition**. With an enabled approved manual rule and current scoped authority, select a verified participant, enter points and a reason, then **Propose bonus**. An independent eligible reviewer opens the existing approval/inbox entry and records their decision. The beneficiary sees the verified-task source in **Contribution → Recognition history**. The task panel refreshes after submission; reopen it after another reviewer acts to see the latest state.

If no manual rule exists, configure it in Contribution and obtain independent approval first. Pending and already-awarded participants cannot be selected again for the same verified participation. Proposer/beneficiary cannot approve; enough other eligible reviewers must exist under the unit's policy. Rule changes can make pending requests stale: withdraw and resubmit under the current rule. Corrections preserve original history and do not permit a duplicate linked bonus. Existing task/event offers and earned points are not recalculated.

`npm run test:work-recognition` and `npm run test:work-recognition:browser` cover the scoped API and real console workflow against disposable data. See [the contract](architecture/WORK_RECOGNITION.md) for privacy, retry and current limitations.

## Technical platform console

After migration 34, `npm run platform:bootstrap -- --policy` adds session-policy read/propose capability to the existing active technical account. Independently run `npm run platform:bootstrap -- --reviewer` to install a separate expiring technical reviewer with read/approve rights. Open **System administration → Session policy**. Propose bounded idle/absolute durations and concurrency using your password; the other account signs in through the ordinary email/password form in a separate browser profile and approves or rejects the displayed proposal. Reviewer credentials are only in ignored `.local/PLATFORM_REVIEWER_ACCESS.md`. Existing quick-login buttons and passwords are preserved. Approved values apply on subsequent logins; history restoration requires a new independently approved proposal. See [session policy](architecture/SESSION_POLICY.md) for expiry, retry and existing-session semantics. No provider, mobile or production activation is implied.

After migration 33, `npm run platform:bootstrap -- --integrations` explicitly enables inventory and connection diagnostics on the active local technical account. Open **System administration → Integrations**. Filter by infrastructure, identity, device, delivery or security. **Check connection** tests only the running database, cache or storage health binding; it accepts no destination or secret. A loaded configuration is not a successful check, and an available service is not identity assurance. Mobile identity, Shield, push and external checkpoint gates are shown as inactive. Provider credential configuration remains subsequent work; approved web-session policy is available separately. See [integration contract](architecture/INTEGRATIONS.md).

For technical administration, use the separate [platform console](architecture/PLATFORM.md). `npm run platform:bootstrap` creates its independent local account and writes the password to ignored `.local/PLATFORM_ACCESS.md`. Use the optional **Technical administrator** development quick-login button or the normal login form; `/platform` opens automatically. Rerunning does not reset credentials or renew/revive grants. The existing six quick-login accounts retain organization scope and cannot open the technical panel.

After migration 32, explicitly run `npm run platform:bootstrap -- --sessions` to enable web-session response on the active local technical account. **System administration → Web sessions** lists active sessions by account class. To terminate another session, select **Revoke**, choose a reason and confirm with the technical account's password from the ignored credentials guide. Current-session logout remains in the sidebar. The affected session is denied on its next protected request; the account can still log in again. This is not account suspension or mobile-device revocation. Password-confirmed response never uses the organizational demo step-up shortcut. The console also provides dependency status and sanitized audit reads; approved session policy is available separately, while provider credential configuration remains subsequent work.

## Scoped member directory

Apply migration `0030_member_directory.sql`, then use `npm run demo:members` to enable member discovery for the six existing local demo accounts. This adds a separate scoped grant and synthetic organizational labels without resetting passwords, requests or previous authority. It does not re-enable previously revoked/expired grants on rerun. Refresh the application; **Members** appears only with current directory access.

Search by a shared organizational name or exact full member code. Filter by unit/subtree, role or membership state. The member card shows only permitted memberships, points and task participation. **Points and recognition** opens existing scoped history and prefills the recipient for a later proposal; **Propose position** opens the existing independently approved appointment flow. Neither navigation submits a change. A restricted points value is distinct from zero. Names never come automatically from email, account or biometric records; the current CLI supplies only authorized synthetic labels.

`npm run test:members` creates a disposable database; `npm run test:members:browser` adds isolated local Chrome checks. See [Members](architecture/MEMBERS.md) for disclosure rules and remaining real-profile/member lifecycle work. This is organizational administration, not the future technical platform administrator account.

## Task definition editing

Migration `0029_work_editing.sql` adds **Tasks → open task → Edit task** for current scoped managers. Edit instructions, priority, time/place, deadline or permitted capacity, provide a reason, and save. History expands the old/new values and participants receive Work inbox notices. No reseed or new grants are needed. Verified participation and pinned reward terms are preserved. Delegated capacity remains fixed; deadlines must respect parent, child and need schedules. Closed/offered tasks do not expose the editor. See [task amendments](architecture/WORK_EDITING.md) for bounds and the remaining archive/delete lifecycle.

If a save loses its response, use **Retry request**; the pending payload/key is retained. A conflict reloads the current task instead of overwriting another manager's changes. `npm run test:work-editing` uses a disposable database; `npm run test:work-editing:browser` additionally verifies local Chrome against that database.

## Private task report retention

Task detail reports use private S3 storage; see the [report contract](architecture/WORK_EVIDENCE.md). In local development, run `npm run evidence:purge` from the ERTAD root to delete up to 25 expired objects. Repeat while a batch is full. The command loads the ignored local environment, refuses production mode, and affects only expired ERTAD report records and their exact generated object keys. It does not remove live task data, other objects or other projects' storage. Do not print credentials or attachment bodies when troubleshooting.

Pending uploads expire after 15 minutes; published reports become unavailable after 90 days. Database expiry blocks reads immediately even when cleanup has not run. Physical object deletion is currently operator-triggered, not scheduled. Before production, supply a least-privilege cleanup identity, monitored scheduling/retries/backlog alerts, encryption and an approved retention policy. A cleanup error exits unsuccessfully and leaves the record retryable; repeated deletion after an audit failure is safe. Do not use bucket-wide deletion or Docker volume pruning as retention maintenance.

## Local network protection

See [network control](architecture/NETWORK_CONTROL.md) for initial migration, explicit account upgrades, tunnel setup, anonymous verification, normal development restarts and authenticated localhost recovery. Country controls are gated until the configured Cloudflare route is verified.

The development runner allows up to 120 seconds for a cold TypeScript startup and still requires passing API/web health checks before starting the tunnel. A timeout is a startup failure, not a successful launch.

## Technical sidebar and creation controls

Technical accounts navigate directly from the sidebar: overview, network protection, monitoring, security limits, sessions, session policy, integrations, provider settings and audit. Only granted tools appear. Each panel has a reloadable `/platform/<section>` address; `/platform` remains the overview. Organizational pages remain separate, and a bookmarked route does not grant access.

**Polls → Create** opens one composer. Choose Poll, Survey, Referendum or Election in its first field, then configure that format's questions, candidates, audience and rules. Existing formats and independent publication controls are preserved.

When creating a task or standalone event, **Award points** explicitly offers **Assign points** or **Do not assign points**. Enabling points requires selecting an available approved rule; it never automatically picks a rule or creates an arbitrary award. If none is available, configure a rule through the existing independently reviewed contribution workflow. Unit changes clear the previous choice. Delegated tasks and linked event participation preserve their inherited terms and existing duplicate-award protections; this control does not rewrite existing rewards.

## Reviewed position definitions

After migration `0040_position_definitions.sql`, `npm run demo:positions` explicitly enables the six existing synthetic management accounts without resetting their passwords, memberships or prior grants. Migration alone grants nobody new authority. Use **Positions and permissions → New position** to choose an authorized unit, name, organizational permissions and their unit/subtree scopes. Provide a reason and confirmation, then submit for independent review under **Approvals**. The configured approval threshold still applies.

**Propose revision** creates a successor definition after approval; it does not silently change existing members' permissions. Use the separate appointment or membership-transfer flow to assign the approved definition. Old approved definitions remain available, and each revision must have a distinct name. Technical administrators cannot create organizational positions. See [the position contract](architecture/POSITIONS.md).

After migration `0041_position_retirement.sql`, **Positions and permissions → Retire position** requests retirement of an unused definition. Give a reason, confirm and send it to **Approvals** for another authorized account to review. Active/scheduled/suspended memberships or pending appointment/revision requests disable retirement; resolve those separately. Approval preserves the definition and history but removes it from appointment choices. The existing position-administration permissions suffice; no extra demo seed is required.

`npm run test:positions` uses a disposable database; `npm run test:positions:browser` adds a local Chrome create/review/revise/review journey. `npm run test:positions:retirement:browser` checks retirement with two independent accounts and asserts the persisted status and unchanged memberships. Browser checks require the local web server on port 15173; API requests go to the test's disposable database. None creates live organizational requests.

## Local security limits

After migration 36, run `npm run platform:bootstrap -- --limits` and `npm run platform:bootstrap -- --reviewer --limits` for explicit operator/reviewer upgrades. They preserve existing passwords and grant expiry. Open **System administration → Security limits**. Propose a bounded API budget, failed-attempt threshold and account lockout duration; the separate reviewer confirms with their own password. Historical values require a new approved proposal. Local policy remains version 0 until a real approval.

See [enforcement and recovery semantics](architecture/SECURITY_LIMITS.md), including the fixed address window, persistent account lockouts, shared ingress ceiling and process-local counters. No runtime counter-reset endpoint is provided.

`npm run check` now includes the admin flat-config lint pass alongside typechecks, tests and builds. `npm run lint --workspace admin` displays remaining warnings instead of suppressing them. The obsolete parallel `.eslintrc.cjs` was removed; `admin/eslint.config.js` is the active web configuration.
