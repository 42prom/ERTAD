# Contribution points

Migration 28 adds [contextual bonuses for verified task participants](WORK_RECOGNITION.md): choose a participant directly from a task, propose an independently approved manual bonus, and retain the source in review/private history. Existing automatic offers and standalone manual awards remain unchanged.

Status: accepted V1 product scope on 2026-10-05; the initial web journey is implemented by migration 14, with verification recorded in STATUS. The October 21 delivery priority is to complete its administrator-to-recipient acceptance after moderation inbox notices. [ADR-016](DECISIONS.md#adr-016--contribution-points-in-v1) extends Activity with configurable non-monetary points. Financial contribution records remain a distinct concept. Levels, leaderboards and the broader gamification release remain later scope.

## Award sources

Migration 23 implements the first [mobilization template](MOBILIZATION.md#recognition-through-the-existing-ledger) extension using this ledger. Independently approved task templates have a stable ID, title, version, enabled state, fixed points, monthly limits and allowed unit/subtree. Root contribution-policy authority manages templates; task creators can select only a currently enabled/latest offer allowed in their own task scope. No template grants a qualification or permission. One task carries one reward offer, including tasks with multiple roles. Migration 27 pins one common offer across an [event's linked and delegated tasks](EVENTS.md); one canonical event/member claim prevents duplicate automatic awards, even after corrections or cap exhaustion. Standalone tasks retain their existing behavior. Per-role overrides and approved multiple-award combinations within an event remain future work. Manual recognition remains bounded and independently approved.

The simple web form explicitly selects a template/default rule or **No reward**. Omission by older clients retains their previous default-rule behavior; explicit null means no automatic award. Work stores the selected immutable rule version. Disabling or replacing a template affects new tasks only; an exact already-committed retry still returns its existing task. Delegation inherits its parent's pinned offer, including no reward, and cannot substitute a new one. Allowed template ancestry is frozen at approval and checked for new selection; a hierarchy move requires a newly reviewed template version. Existing Work ancestry checks continue to govern the task itself.

The template catalog is bounded to 64 identities per organization. Member monthly caps retain the existing gross task-category accounting across all task templates and versions, not a separate refillable allowance per template; reversals do not reset usage. Each offer's cap is shown before creation and on task details. Private history now includes the pinned template title without adding source identifiers, exact event timestamps or beneficiary information to notices. The existing source-unique Activity trigger, audits, beneficiary exclusion and compensating correction flow remain authoritative.

| Source | Confirmation required | Award basis |
|---|---|---|
| Voting participation | Server-accepted eligible participation in a Decision | Published participation rule, independent of selected option, candidate, outcome or political preference |
| Survey participation | Server-accepted completion under that survey's rules | Completion only; no answer-dependent reward or disclosure of anonymous answers |
| Task/activity/event participation | Verified completion or attendance under the applicable domain policy | Published rule for the verified activity; opening a screen, applying or submitting an unverified claim is insufficient |
| Individual recognition | Authorized manager's scoped manual award | Custom integer amount and reason within the super administrator's configured limits and approval policy |

An organization can enable, disable and configure each source. Exact amounts are administrator configuration, not hard-coded product constants. A source event receives at most one award in the corresponding category; a survey represented by a Decision cannot earn both a vote award and a survey award accidentally.

## Administration and permissions

The super administrator configures versioned award rules in the existing web management application: eligible event type, amount, effective period, per-event/member-period caps, permitted manual-award scope/limits, and when independent approval is required. Rules are validated data, never executable expressions or scripts. Publishing permission-affecting changes follows Governance Approval.

The super-administrator designation is a product responsibility, not an authorization bypass. Rule management and manual awards require explicit current server-side permissions and organization/unit scope. A platform-wide template is activated explicitly for an organization; no implicit cross-organization award or combined balance is introduced. Higher-level managers may award within their assigned subtree only if delegated that permission and allowance; hierarchy rank alone is insufficient. They cannot award themselves or approve a request benefiting themselves. Out-of-scope, expired, revoked and over-limit operations fail. Ordinary automatic participation awards do not require a separate human approval each time.

Manual awards retain the recipient, scoped issuer, bounded amount, reason, policy version and optional permitted activity reference. Approval is required when the configured policy demands it, rather than adding a universal approval workflow to every small award. A request stores immutable proposed parameters; authority, allowance and approval independence are revalidated when issued. Concurrent requests cannot exceed an allowance. Reasons and references are protected operational data; audit/notification payloads use minimal identifiers.

## Ledger and lifecycle

The Activity module owns an append-oriented points ledger and its per-organization totals. Use the existing PostgreSQL transaction/audit infrastructure; introduce concrete storage only with the first working award journey. Preserve reusable history/presentation components without restoring currency payout code or wallet dependencies.

An award records the beneficiary's opaque ID, organization, source category and canonical source-event reference, rule/version, amount, issuer where applicable and privacy-appropriate accounting period. Balance is derived from accepted awards and compensating entries; users and managers cannot directly overwrite it. Issuance amounts are bounded positive integers; disabled rules issue nothing. Corrections and revocations add linked compensating entries with a reason, required approval and audit; do not silently edit or erase past awards. An original award cannot be reversed more than once through retries or competing requests.

Use source-based uniqueness independent of rule version so rule publication cannot reward the same participation twice. Manual issuance uses payload-bound idempotency; retrying the same request cannot issue twice and a materially different payload with the same key conflicts. Where source event, Activity, points and required audit must succeed together, share a transaction; where delivery is deferred, durable reconciliation and uniqueness must prevent missed or duplicate awards. External notification failure cannot remove an earned award.

Rules apply prospectively. Pin the earning rule before a Decision opens or an activity accepts participation; members can see the applicable offer. Mid-event edits cannot silently change the earned amount or create different rewards for different answers. Cancellation, invalidation and correction behavior belongs to the published policy; do not invent undisclosed penalties or retroactive deductions. A justified correction uses the explicit compensating workflow.

## Privacy and authority

Points recognize contribution. They do not grant voting weight, a position, permissions, protected identity access, candidacy or automatic promotion. Qualification and objective verified experience retain their own policy; the accumulated points total cannot substitute for them. Points have no transfer, withdrawal, exchange or cash-redemption operation.

Anonymous participation awards may reference the protected participation record, never a ballot ID, choice, answer, receipt, choice fingerprint or shared actor-to-ballot correlation token. The rule amount must be independent of choice. Ledger, audit, outbox and notifications must preserve the Decision's timestamp-minimization policy rather than reintroduce precise correlation metadata. This preserves the application-level privacy boundary in ADR-014 and does not claim anonymity against compromised infrastructure.

The member sees their own total and history through Status/Activity. Managers see only authorized scoped information; no public member list, cross-organization ranking, public balance or leaderboard is introduced. Apply private-profile disclosure rules to totals, labels and filtered aggregates. External notifications contain no sensitive participation or award details by default. Use the existing bilingual web tables/forms and mobile theme families.

## Delivery and acceptance

1. First task/Activity journey: implement the minimal versioned rule, verified activity award, ledger/total projection, scoped rule management and member history. Identity and membership gates still precede awards.
2. Extend the same ledger with delegated manual awards, limits, reasons and policy-dependent approval using the existing review UI. Add automatic voting/survey participation only when the new Decisions engine and its privacy tests exist.
3. Before V1 release, verify source confirmation; identical and conflicting retries; source uniqueness across rule versions; category overlap; concurrent allowance exhaustion; authority expiry/revocation; self-award/approval denial; rule changes during an open event; cancellation/reversal retries; transaction/audit rollback; notification outages; organization/private-profile isolation; no points-based authority; and no ballot/answer linkage in persisted/emitted data. Exercise web/mobile history and bilingual error/offline states.

Migration 14 implements versioned organization rules, prospective task/Decision offers, verified Activity and named vote/survey awards, private history, capped manual recognition and compensating reversals. `/contribution` uses the shared collective approval flow for rule changes and manual awards. This initial policy always requires independent approval for manual recognition; automatic accepted participation needs no additional human vote. Monthly caps count gross issued points across rule versions; reversals do not refill the allowance. Cancelling a Decision compensates its awards. Anonymous rewards remain disabled until the anonymous Decisions privacy contract is implemented. See STATUS for executed checks and local activation.

## Recipient notices and web acceptance

Migration 21 adds **Contribution and recognition** to the shared inbox/bell by projecting the immutable ledger. Awards, compensating corrections and cap-reached records produce separate recipient-only notices. Pending/rejected/withdrawn/expired proposals create no earned-points notice. Administrative proposal notifications remain separate; receiving an award grants no access to review deliberations.

Only read markers are stored separately, keyed by organization, entry and recipient. Version is always 1 because ledger entries are immutable. Reading an original award cannot consume its later correction. Current access follows existing own-history authority: active authorized unit access in the organization. Revocation hides counts, notices and exact lookup without erasing earned history. Moving within the organization preserves the member's own history. Other members and managers do not inherit recipient notices through scoped history permissions.

Previews exclude amounts, reasons, issuer, rule and source-event identifiers. They preserve the coarse earning date (UTC midnight in transport, date-only presentation); no precise event timestamp is introduced. Named task/vote/survey rewards reuse the projection; anonymous rewards remain disabled. Unit labels follow shared inbox disclosure rules.

`/admin/collective/points` accepts `entryId` for exact own-entry lookup, including records outside the current page. It rejects combined member/unit selectors, rechecks authority after audit, and returns the existing private entry projection with the member's total balance. Transient navigation keeps IDs out of URLs. Opening neither acknowledges nor awards; **My full history** restores the normal view.

Web forms lock scope changes while editing, preserve uncertain-response retries, close after confirmed retries and clear unavailable actions on denial. Pending proposals never increase balances. Independent approval remains mandatory for manual awards/corrections and excludes the beneficiary. No new ledger or delivery worker is introduced.

`npm run test:contribution-inbox` covers recipient isolation, lifecycle, concurrent reads, audit rollback, real permission/deadline expiry, SQL/HTTP boundaries and exact lookup beyond one page. `npm run test:work` retains source/cap/correction checks and validates minimal notices for automatic and manual entries. The `test:contribution-inbox:browser` command exercises real rule/award/review/recipient/correction forms in a disposable database, paced to honor rate limits. STATUS records executed evidence and pending checks.

Secure attachments follow this checkpoint. Mobile history, anonymous rewards, configurable approval exemptions and production qualification remain separate work; neither XP/levels nor leaderboards are introduced.
