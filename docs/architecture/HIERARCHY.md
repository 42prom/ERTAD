# Reviewed hierarchy lifecycle

The first W1 journey is child authority-unit creation. `/units` shows a paginated scoped list with parent labels, search and creation actions, plus pending/own/history request views. It reuses the existing console, controls, sessions, CSRF, scope projection and strict transactional audit. Membership requests remain at `/reviews`; the queues are separate typed views for now.

## Contract

- Reads require current `unit.read` scope. Hidden ancestors are represented as a scope root, without exposing their names or IDs. Counts and search use the same scope as rows. Pages contain at most 25 items; concurrent edits can shift offset pages.
- Creation requires `unit.propose` on an active authority parent plus `unit.read`. The proposal freezes parent ancestry, name, reason and deadline (at most seven days). The web form uses six days. No unit, position or membership is created by proposing.
- A different member with `unit.approve` and `unit.read` can approve/reject with a reason and fresh step-up. The original proposer must still hold the required authority. Parent ancestry drift, archived ancestry, expired requests, revoked authority and duplicate active sibling names prevent approval.
- Approval inserts one child authority unit and closes the request in the same transaction as audit. Rejection creates no unit. No position or membership is assigned; existing subtree permissions naturally cover the new child.
- The runtime role cannot write units or review rows directly. Migration `0006_unit_creation_reviews.sql` adds a typed table and narrowly exposed database functions. Session/account/member, organization and audit locks follow the existing review order. Authority and deadlines are checked again after audit, before commit.
- Request and decision keys bind to their original payload. Concurrent identical decisions return one result; conflicting retries fail. Requests and completed decisions are immutable. The web keeps an uncertain submission in memory for retry; reload does not restore an unsent draft.
- Audit contains opaque actor/organization/review references and operation, not the proposed name or free-text reason. No real-person data belongs in the demo.

## Local demonstration

After applying migrations, `npm run demo:hierarchy` explicitly adds a separate approved permission bundle and bounded hierarchy memberships to the six existing synthetic accounts. It preserves passwords, original membership requests and prior grants. Re-running does not restore revoked grants or overwrite outcomes. This owner-only development action is not production bootstrap. A migration alone grants no new authority.

Use regional account 1 to propose a child below its region, then account 2 in that region to approve. The other region cannot read the request or new unit. Council accounts can act only through their persisted subtree permissions and cannot approve their own requests.

The workspace now exposes **Create group**, **View groups**, and **Group requests awaiting approval** directly. Create group opens `/units?create=group` with parent-selection guidance; the approval link opens `/units?view=pending`. The sidebar calls this screen **Groups and regions**. These entry points use the same scoped request/independent-approval workflow; submitting a request alone does not create a group.

## Verification and remaining scope

`npm run test:units` uses a disposable database and real auth/SQL/HTTP boundaries. `npm run test:units -- --browser` additionally uses Chrome and the local Vite server with transport routed to the disposable API. These runs never consume the user's demo requests.

## Reviewed rename, archival and restoration

Migration 38 extends the same immutable unit reviews and unified inbox with `rename`, `archive` and `restore`; it adds no separate CRUD service or request table. `/units` has row actions, original/proposed names, request kinds, explicit archival/restoration confirmation, blocker explanations and an Active/Archived filter. The existing pending/own/history views handle all four request types. Unknown results retain the exact in-memory payload/key for retry.

Changes require explicit `unit.change.propose` / `unit.change.approve` and `unit.read` on the target's active authority parent. These capabilities govern its immediate children; creating units does not implicitly grant change authority. Council-scoped grants can therefore manage regions, while regional-scoped grants manage groups beneath that region. The organization root cannot be renamed, archived or restored through this journey. Technical administration grants provide no organizational authority.

Each request freezes the target ID, version, original name and parent ancestry. A different authorized member must approve. The proposer must still be authorized; current session, password confirmation, deadline, ancestry and unit version are checked again after the audit write. Rename/archive/restore preserves the unit ID, memberships and all historical records. The version increments once, only on approval; concurrent identical retries return the stored outcome. Active sibling name conflicts block rename/restoration. Rejection changes no unit.

Archival currently supports **empty authority leaves only**. Children (including archived children), memberships, positions, task/decision/channel/event/activity records, qualifications, governance policies/proposals, points rules and pending incoming requests block archival. Blockers are re-evaluated at proposal, approval and after audit. Completed operational records also block archival until their domains provide explicit historical reads through archived scopes; archiving must not make those records inaccessible. Only blocker categories are disclosed, never attached record identifiers or counts. This is a deliberate bounded first lifecycle, not bulk archival of populated regions.

Archived units disappear from active lists and remain in the scoped archive under their active parent. They cannot receive new work through active authority checks. Reviewed restoration reactivates the same ID without restoring/recreating memberships or grants. The original approval history remains available. Root reparenting, hierarchy moves, bulk operations and populated-unit archival remain separate contracts.

`npm run demo:unit-changes` explicitly adds one separate approved bundle and six bounded synthetic memberships. It preserves passwords, existing requests and grants, and never revives an existing revoked/expired lifecycle bundle. A migration alone grants no new authority. `npm run test:units` covers the SQL/HTTP security and lifecycle boundaries; `npm run test:units:lifecycle:browser` exercises rename, independent approval, archival, scoped archive and reviewed restoration against a disposable database.

Migration 39 adds reviewed transfer and termination of a selected membership; see [membership lifecycle](MEMBERSHIP_LIFECYCLE.md). W1 remains incomplete: editable position/permission-version administration, coordinated multi-membership transfers and real identity acceptance remain. The scoped member directory and unified multi-type inbox already exist. Professional/project unit definitions, durable external notification delivery, production MFA and external signed audit checkpoints are separate remaining work.
