# Web review inbox and notifications

Updated 2026-10-05: the first recurring membership/position review journey is implemented at `/reviews`, with the development API under `/api/v1/admin/reviews`. This is one typed Approval operation, not a completed general Approval engine. The development installation bootstrap remains a separate offline ceremony.

The unit journey at `/units` and `/api/v1/admin/units` reuses session/scope/audit controls; it now includes creation, rename, empty-unit archival and restoration. The unified inbox already combines actionable domain queues. Migration 39 extends membership reviews with independently approved transfer/position replacement and termination; see [membership lifecycle](MEMBERSHIP_LIFECYCLE.md) for two-scope authority and responsibility blockers, and [hierarchy](HIERARCHY.md) for unit changes.

## Implemented boundary

- A proposer with current `membership.propose` scope can request an existing active organization's member receive an existing approved position. Target lookup uses an exact opaque member reference; it is not enrollment or a member directory. Requester labels are opaque references until authorized profile projections exist.
- A different actor with current `membership.approve` scope approves or rejects with a reason and fresh password step-up. Neither requester nor beneficiary can decide. The position's unit, bundle ID and version are frozen in the request and rechecked before granting. Requester authority, target eligibility, sessions, deadlines and existing memberships are revalidated. Requests expire within seven days; grants in this initial flow must expire within 365 days.
- Migration `0005_membership_reviews.sql` adds canonical review records and minimal recipient notification/read state. Runtime has no direct review, notification or membership write privilege. Narrow database functions validate live authority under session/identity/organization locks; the API writes strict audit in the same transaction and rechecks temporal validity before commit. The SQL scope projection uses the same persisted membership/position/version/ancestry model as the typed unit-read policy. No role-name bypass is introduced.
- Request and decision keys have explicit same-payload retry behavior; competing decisions serialize, and a stale/conflicting request returns 409. Lost responses retain the same submission in page memory for retry. Reload does not preserve an unsent form or its in-memory retry payload; committed requests remain available in My requests/History. A future durable draft/reconciliation flow must keep protected payloads out of ordinary browser storage.
- The table has pending, own requests and history views; organization/unit/status/UTC creation-date filters, debounced unit/position search, reset, matching counts and 25-row pages. Ordering is deadline plus request ID. Pagination is bounded offset pagination, not a snapshot: concurrent changes can shift page boundaries. Only the view tab is persisted in the URL; protected references and search text are not.
- Decisions atomically enqueue two minimal in-app notifications for requester/beneficiary. Notifications are pulled from PostgreSQL (latest 50), and visibility is rechecked with canonical request scope after revocation. Read marking is idempotent and does not decide a request. There is no third-party delivery, push worker or generalized messaging service in this batch.
- The existing layout, Card/Button/Input/Select, session/CSRF and password verification are reused. The new page and language/theme controls support Georgian/English and system/light/dark preferences, with responsive navigation and keyboard focus. Detail and confirmation forms are inline, avoiding nested dialogs. Older source screens remain to be adapted fully.

`npm run test:reviews` runs 18 disposable database/HTTP scenarios. `npm run test:reviews -- --browser` additionally uses two real Chrome sessions against that disposable API, with API transport redirected from the local Vite page. It exercises creation, independent decision, notification, reload and revocation, plus both languages/themes at 360/390/768/1440 widths and keyboard focus. Screenshots use synthetic data only. Seven React behavior tests cover failure/empty distinction, independence, filters, conflict, lost-response retry and notification separation.

The 2026-10-07 explicitly authorized web demo adds six synthetic identities with scoped memberships and two initial review fixtures in one demo organization (ADR-017). The existing local administrator remains unchanged and receives no review authority from its legacy role. Demo labels are restricted fixture projections; they are not verified real-person enrollment or a general member directory. Production MFA/person assurance, profile projections, enrollment, other approval types, external audit checkpoints and notification retention remain release work.

## Target administrator workflow

The existing web application will gain a review inbox with a scoped pending count in navigation. Its primary views are **Needs my decision**, **My requests**, and **History**. A separate notifications view handles informational updates and unread/read state. Reading or dismissing a notification never approves, rejects, deletes or completes the underlying request.

The table shows request type, a permitted requester label, organization/unit context, a short safe summary, creation/deadline, current status and a detail action. Requester labels come from authorized profile projections, not legal identity or an unrestricted member directory. Counts and filtered results are scoped by the same server policy as the detail view; hidden requests must not leak through totals.

Filters include request type, permitted organization/unit, status and date range, with search, reset, bounded pagination and clear empty/error states. Only non-sensitive filter state belongs in URLs. Sorting prioritizes approaching deadlines, with stable identifiers to prevent duplicate or missing rows across pages.

The detail view presents the immutable proposed change, operational reason, requested duration, required approvals and decision history. Confirm and reject actions require explicit intent and a decision reason. The server rechecks the session, membership, permission, scope, request version, independence and expiry at execution. Opening a page, receiving a notification, possessing an old URL, or seeing an enabled button supplies no authority.

After a competing reviewer decides, a client with an old page must see the current result and cannot overwrite it. Retries after a lost response return the same decision without applying the change twice. If authorization was revoked, the request expires, the target changes, or audit persistence fails, no mutation is accepted. Own-request and own-grant approval are rejected by the server as well as explained in the UI.

## Reuse and adaptation

| Existing surface | Planned reuse | Necessary adaptation |
|---|---|---|
| `admin/src/pages/Tickets.tsx` | List/detail navigation, filter toolbar, pagination and status presentation | Approval-specific contracts, scoped counts, stable server pagination, localized labels and semantic tokens; no copied ticket authorization |
| `admin/src/pages/MessagesList.tsx` | Tab/filter and notification presentation patterns | Separate notifications from authored announcements; failures must not silently render an empty successful inbox |
| `admin/src/components/Layout.tsx` | Navigation and page placement | Server-permitted inbox/counts; role names are not authorization |
| Existing Card/Button/Input/Select/Modal primitives | Shared controls and confirmation layout | Complete focus trapping/restoration, keyboard/Escape behavior, dirty-form protection, Georgian/English and day/night behavior where missing |
| Existing web session, CSRF, password step-up and audit code | Authentication and mutation protection | Scoped domain authorization and independent approval; production MFA remains mandatory |

No parallel component gallery or generic workflow builder is needed. The first request type will be a proposed membership/position grant. Later V1 approval types—permission-definition changes, promotion and restricted disclosure—join only after their own typed mutation and privacy contracts exist. Decision polls do not substitute for Governance Approval.

## Delivery sequence and acceptance

1. Implement a persisted membership-change request with immutable parameters/version, reason, deadline and independent decision history. Revalidate authority and apply the membership mutation with audit in one transaction. Test self-grant/own approval, scope errors, revocation, expiry, version drift, duplicate requests and concurrent decisions.
2. Add scoped list/count/detail APIs and connect the reused web table and detail dialog in the same delivery. Exercise two separate browser sessions so only an authorized independent reviewer can act; verify reload, retry, denied and stale-page behavior.
3. Add minimal durable notification delivery/read state for that actual request lifecycle. A notification links to the canonical request, which remains protected even after access changes. Default third-party payloads disclose no requester, reason, membership or protected identity. Notification failure cannot erase a committed decision.
4. Validate Georgian/English, both themes, keyboard/focus and 360/390/768/1440 layouts. Table and dialog tests accompany API/database tests; no synthetic success, fabricated badge counts or working-looking controls for unavailable actions.

Remaining project work is still substantial: full private-profile/enrollment/recovery, recurring governance approvals, the first task/verification/Activity journey, communication and Decisions, broader web/mobile adaptation, and production/device acceptance. Source transfer and feature removal are complete baseline work; they do not establish a percentage of completed ERTAD functionality.

## Universal multi-admin threshold consensus and notifications (ADR-021)

The user's 2026-10-14 governance requirement expands single-reviewer approvals into an extensible, unit-scoped **Multi-Admin Consensus Engine**. This engine serves as the single foundation for any administrative action requiring collective consent rather than unilateral decree:

### 1. Unified Schema and Lifecycle
- **`governance_proposals`**: Captures unit scope (`unit_id`), initiator (`proposer_id`), action type (`TASK_PUBLISH`, `POINTS_AWARD`, `DIRECTIVE_ISSUE`, `BUDGET_CONFIRM`, `ROLE_ASSIGN`), JSONB action payload, deadline, and threshold rule (`MAJORITY`, `SUPERMAJORITY`, `UNANIMOUS`, `FIXED_COUNT`).
- **`governance_proposal_votes`**: Records each voting administrator's identity, decision (`APPROVE` / `REJECT`), mandatory justification reason, timestamp, and step-up verification.
- **Atomic execution**: When the threshold-satisfying vote is committed, the target domain mutation runs within the same transactional boundary. If rejected or expired, the proposal terminates and no domain mutation occurs.

### 2. Targeted Notifications & Actionable UI
- **Targeted notification dispatch**: Upon proposal creation, notifications are delivered specifically to active administrators within that proposal's unit scope.
- **Actionable review cards**: The inbox presents explicit **Approve** and **Reject** buttons directly on the proposal card.
- **Visual quorum progress**: A live consensus indicator displays current agreement (e.g., `[ 2 of 3 approved ]`) and lists all participating administrators with their votes and reasons.
- **Step-up confirmation**: Clicking Approve or Reject opens a focused confirmation dialog requiring a decision reason and recent authentication (password step-up or WebAuthn in production).

### 3. Cross-Domain Integrations
- **Directives**: Council or regional policy declarations require majority agreement among that unit's administrators before publishing.
- **Work & Tasks**: High-impact or high-budget work items require collective unit authorization before releasing to participants.
- **Contribution Points**: Manual awards or adjustments (ADR-016) require multi-admin approval to prevent self-awarding or favoritism.
- **Decisions**: Binding or structural polls require administrative consensus before electorate snapshot and publication.
