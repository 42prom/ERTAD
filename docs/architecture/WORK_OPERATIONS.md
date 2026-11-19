# Work, needs and funding configuration

Product direction: 2026-10-13. The running baseline and validation evidence are documented in [WORK](WORK.md) and [STATUS](../STATUS.md). The implementation reuses the modular API, database, scoped permissions, approved memberships, audit, command receipts, console components and Activity source. Financial contribution remains separate from [recognition points](CONTRIBUTION.md).

Implementation checkpoint: migration 11 delivers coordinator, weighted independently verified criteria, blockers and scoped queues. Migration 12 adds multi-role quotas, inherited child roles, verified qualifications, resource/service pledges, independent receipts/returns and mandatory start/completion gates. Migration 13 adds collective review, external funding accounting and private member projections. Migration 14 adds prospective contribution rules and a separate points ledger. Combined domain inbox/reporting, private file evidence and external delivery remain later work; source tests and activation evidence belong in STATUS.

The funding summary is explicitly published after independent approval. It requires at least ten net-positive contributors, ten contributors not in the previous publication cohort, and at least 24 hours between publications. Members see a dated snapshot; finance controllers see current scoped records. Returning a contribution does not erase its receipt. Child budgets reserve existing funds rather than creating income. One target supports direct child envelopes; deeper allocations require a separately designed accounting contract.

## One work card

A work card owns the objective, responsible unit, accountable coordinator, dates, priority, measurable completion criteria and optional needs. It can represent a normal task or a people/resource/service/funding request using validated configuration and the same lifecycle. A task may combine several needs; do not create disconnected copies of the same task in four modules. Child work is a bounded allocation or separately defined deliverable, with an explicit relationship to the parent's objective.

Needs have a type, required quantity/unit, confirmed allocation, remaining gap, responsible person and deadline. People needs use declarative role slots with enforced qualifications; resources use typed quantities and units; services use deliverables and independent acceptance; funding uses a currency-specific target and accounting entries. Optional sections appear only when enabled. Record commitments separately from confirmed provision. Returned equipment and cancelled commitments restore availability through recorded transitions.

Keep three separate dimensions: **execution** (not started, active, blocked, awaiting verification, finished), **readiness** (which mandatory needs are fulfilled), and **funding** (goal, confirmed receipts, expenses, remaining need). Receiving the budget does not complete the task; spending it does not prove delivery. An optional unmet need does not automatically block all execution. The approved task defines mandatory start gates and completion criteria.

## Scope and responsibility

| Actor with explicit grants | Operational view | Allowed control | Financial/private details |
|---|---|---|---|
| Council/super administration | Organization-wide work and authorized regional drill-down | Publish policies, allocate within approved scope, review escalations and intervene with an audited reason | Separate financial/identity permissions; rank alone does not disclose private profiles |
| Regional manager | Own region and descendants | Create, delegate, rebalance authorized allocations, verify others' work, escalate shortfalls | Own scope only; financial approval requires a separate grant |
| Group management team | Own group and explicitly delegated descendants | Receive/partially receive work, allocate role slots, report blockers and verify completion independently | Own permitted records; no sibling/ancestor operational authority |
| Member | Eligible published tasks, own participation, task-level needs and permitted financial summary | Volunteer, offer a resource/service or funding pledge, report assigned work | Own contribution records; no donor directory, bank details or other members' private evidence |
| Scoped finance recorder / approver | Assigned financial records | Propose receipts/expenses/refunds; a different authorized person confirms them | Only necessary financial evidence; neither role confers general platform authority |

Being an operational manager does not automatically grant financial approval. Permission bundles assign operation plus unit/subtree scope. Publishing a task to members is an explicit audience decision, independent from manager oversight. Default member audience is the owning branch; organization-wide publication requires an appropriate root-scoped grant. A shared funding summary cannot reveal an otherwise hidden child task, donor or member. Existing scope checks apply to lists, totals, filters, exports and notifications as well as details.

## Progress and oversight

The management screen offers list, hierarchy and needs views over the same authorized records. Start with list and expandable child work, then add a hierarchy view when it conveys more than the existing table. Each row shows accountable unit/coordinator, verified progress, due date, mandatory shortfalls, blocker and pending decision. Useful filters are unit, accountable person, state, overdue, need type and needs-my-decision. No public member picker is introduced.

Completion criteria receive fixed weights when work is approved; weighted verified deliverables determine the official progress percentage. Participant self-reported percentages remain visibly separate estimates. Do not average arbitrary tasks or add parent/child percentages together. Work without configured measurable criteria shows counts and stage, not a fabricated percentage. Parent summaries aggregate canonical leaves once. A hierarchy move requires explicit reviewed reassignment before access/allocation follows the new ancestry.

Blockers include reason, affected need/deliverable, owner and next action date. Escalations notify the nearest authorized accountable manager and can proceed upward under policy; a blocked or late task never disappears from the queue. Inbox entries link to accept/decline, staffing, verification, funding confirmation, expense review and deadline/blocker decisions. External delivery remains privacy-minimized and later than durable in-app delivery.

The work card uses the existing visual family: overview and next actions first, then participants/needs and an optional funding panel; a chronological activity panel carries changes. Avoid separate main-menu items for every subtype, hidden ownership or a large configuration wizard for an ordinary task.

## Funding accounting

V1 records money reported and independently confirmed outside the application. It does not take payments, hold balances as a wallet, store card data or claim bank settlement verification. A member may pledge help; a pledge is never displayed as received money. Approved receipts require a source/reference and restricted evidence. A recorder cannot approve their own record or expense. Corrections use linked compensating entries; no editing or deleting an approved amount.

Each target has one currency, an approved versioned goal, purpose, accountable unit, deadline and audience. The organization may choose GEL as its default; currency is explicit on every amount. Store integer minor units and return safe decimal strings through the API. No floating-point accounting, implicit exchange rate or cross-currency total. Child envelopes inherit the target currency.

| Member-facing figure | Meaning |
|---|---|
| Needed | Current approved goal |
| Confirmed collected | Approved external receipts minus confirmed refunds/corrections |
| Still needed | `max(goal - confirmed collected, 0)` |
| Spent | Approved expenses minus expense reversals |
| Committed | Approved reservations for expenses not yet recorded as spent |
| Available | Confirmed collected minus spent minus outstanding commitments |

Show the funding progress against confirmed collected, with the actual amount retained if the goal is exceeded. Show financial freshness/verification status. A proposed receipt or unsupported screenshot stays pending and does not change public totals. Commitments and spending have limits under the approved budget and available funds; concurrent approvals cannot reserve/spend the same capacity twice. Converting a commitment to an expense releases that reservation in the same transaction, preventing double subtraction.

For example, a goal of **5,000 GEL**, confirmed receipts **3,200 GEL**, separate unconfirmed pledges **600 GEL**, expenses **1,100 GEL** and outstanding commitments **500 GEL** means: **64% collected**, **1,800 GEL still needed**, and **1,600 GEL available**. The pledge does not increase the collected figure. Financial readiness and task execution progress are shown separately.

Default hierarchical budgeting uses one funding target with bounded child envelopes. Allocation to a child reserves part of the parent's budget; it is not a new donation or receipt. If separately approved targets are linked, aggregate external source records once and show internal transfers as paired movements, never duplicated income. A budget increase or reassignment is a separately approved versioned change. If a task is cancelled after receiving money, close operational work while leaving financial reconciliation visible until refunds, approved reassignment or final expense settlement completes. Never silently move donor funds to another purpose.

Members see the approved purpose and permitted aggregate figures, not donor identities, bank references, receipt attachments or transaction-level timestamps. Financial controllers see the necessary restricted records. Member projections must prevent inference from small cohorts, repeated filtered totals and precise updates: no arbitrary donor/rare-attribute filters; coarsen or delay publication when required by disclosure policy and obtain explicit consent for any named public recognition. No money-based authority, election eligibility or automatic points proportional to donations.

## Delivery sequence and acceptance

1. **Operational oversight:** accountable coordinator, measurable deliverables, blockers, scope-safe parent summaries and manager/member projections. Preserve the deployed task lifecycle and current synthetic accounts.
2. **Needs:** multiple role slots and enforced qualifications, resource/service requests, pledges versus confirmed allocations, partial fulfillment, withdrawal/return and bounded delegation. Give managers a shortfall queue.
3. **Funding vertical slice:** target/budget publication, member summary, pending receipt, independent confirmation, append-oriented corrections, expenses/reservations, refund/reallocation reconciliation and financial notifications. Add tables and permissions only with this usable flow.
4. **Unified inbox and reporting:** combine domain queues without widening access; add privacy-safe exports and measured aggregate performance. Mobile follows the established group/member policy after web flows are complete.

Required tests include sibling/ancestor/organization denial, independent approver denial, revoked scopes during an operation, truthful pending/confirmed totals, concurrent last-place/resource/budget allocation, payload-bound retries, duplicate source/reference rejection, exact minor-unit arithmetic, currency isolation, pledge partial fulfillment, refunds/reversals, reservation-to-expense conversion, parent/child double-count prevention, cancellation reconciliation, approved budget version changes, audit failure rollback, scoped member projections and inference-resistant disclosure. Exercise the same cases through real HTTP and the web UI, with synthetic data only.
