# Mobilization and contribution delivery

Product decision: 2026-10-22. ERTAD coordinates voluntary participation and practical support through its organization hierarchy. The primary experience is a clear invitation, participation, confirmed completion and understandable recognition. This document sets the next implementation order; current runtime evidence remains in [STATUS](../STATUS.md).

## Simple operational flow

Reuse WorkItem and assignments for participation, driving support, logistics and other approved activities. A simple card contains a title, written instructions, responsible unit, target audience, applicable time/place, optional capacity, materials and the visible reward offer. It explains who can join and who confirms completion.

The journey is: read, opt in, receive an assignment where capacity/eligibility requires selection, report completion, then receive confirmation or a reasoned request for correction. Participation remains voluntary. Opening a card, applying, uploading a file or clicking completed never earns points by itself. Retain the existing server lifecycle and transactional capacity controls.

The verifier holds current explicit authority within the hierarchy and is independent of the beneficiary. For ordinary members this can be an authorized group administrator; a group administrator's own contribution requires an authorized independent higher-level reviewer. Upper levels oversee only their permitted subtree. Position names do not confer access. Migration 26 implements [hierarchical completion review](WORK_REVIEW.md), including pinned review floors, current-authority checks, per-participant controls and matching inbox actions. Root managers require another eligible root reviewer; missing authority never enables self-review or a lower-level fallback.

Advanced criteria, blockers, qualifications, resource/service needs and financial accounting remain available in optional sections. Ordinary attendance or practical assistance must not require budgets, weighted criteria, percentage reports or evidence uploads. Preserve existing records and configured requirements when simplifying forms; hiding an existing completion gate cannot remove it.

## Events and practical roles

An event supplies shared title, time, location when needed and links to operational WorkItems. Reuse Work for staffing/services, channels for coordination, the inbox for requests and Activity/Contribution for confirmed outcomes. Migration 27 implements the thin [event wrapper](EVENTS.md), including scoped task discovery and one canonical reward occurrence per event/member. It does not add a second staffing, approval or points engine.

A gathering can have a participation invitation and a linked driving-support task. The latter may describe meeting time, route and available seats, with appropriate driver eligibility. Seats describe service capacity; they are not automatic point multipliers. Other practical roles use approved data definitions without a separate code path for each role.

## Recognition through the existing ledger

Super-administrator policy defines approved activity/reward templates and delegates their use within scope. Managers select an allowed template before accepting participation. Templates specify activity/role, enabled state, fixed integer points, confirmation requirement, policy version and caps. Start with declarative fixed awards and explicit limits, not custom formulas or executable configuration. Driving support and general participation can have different approved templates; actual amounts are administrator choices.

Pin the offer before participants commit and show it on the card. Existing tasks keep their pinned rules and earned history. Rule changes apply prospectively. Migration 23 extends the current rule/offer/ledger structures with independently approved, subtree-scoped task templates and an explicit no-reward choice. One task pins one offer; different automatic amounts for different roles currently require separate tasks. See [Contribution](CONTRIBUTION.md) for compatibility, monthly caps and remaining per-role/event extensions.

| Source | Confirmation and award policy |
|---|---|
| Participation/support task | Independently confirmed contribution, using the allowed template pinned to the work |
| Event attendance | Confirmed attendance; reuse its canonical occurrence so the event and a mirror task cannot both reward the same attendance |
| Named vote/survey | Accepted eligible participation/completion under the existing rule, never the answer, candidate or result |
| Custom recognition | Scoped reasoned amount within allowance, retaining independent approval and beneficiary exclusion |
| Funding/resources | Separate operational accounting; no automatic conversion of money into points or authority |

Distinct work at one event may earn separate awards only under an explicit approved combination policy. A driving assignment and attendance may be distinct; mirrored parent/child tasks and repeat verification are not additional contributions. Migration 27 starts with one pinned automatic offer per event/member, shared by linked and delegated tasks. Multiple completions retain Activity but do not stack points; caps and corrections cannot reopen that occurrence. Configurable multi-role combination policies and deduplication of unrelated real-world records remain later work.

Manual recognition remains available for exceptional contributions with a bounded custom amount and reason. Retain current mandatory independent approval, issuer/member caps and corrections. A discretionary bonus linked to already rewarded work must be identified as such, not disguised as another automatic award. Configurable approval exemptions remain separate work.

Activity remains meaningful when rewards are disabled or a cap is reached. Confirmation, points and required audit retain transactional consistency and idempotency. Corrections add compensating entries. Members see the source, applicable offer, outcome and corrections privately. Points confer no permissions, voting weight, appointments, cash entitlement or public rank. Anonymous rewards remain gated on their privacy implementation; referrals and broader gamification remain later scope.

## Materials and next delivery order

Written instructions are sufficient for a simple invitation. Add optional HTTP(S) links and private images/PDFs as supporting capabilities. Do not fetch links automatically for previews. Attachments need content/type checks, scoped downloads and retention, without routine identity collection or hidden location tracking. The current text-report slice is usable but is not a complete materials editor.

1. Simplify Work creation and participation using the existing lifecycle; make advanced sections optional and clearly show audience, confirmation and reward. Implemented first slice: optional start/place, default participant role/priority, optional advanced settings and collapsed unused oversight/resource/funding controls. Existing configured criteria and needs stay visible.
2. Add approved activity/role reward templates, restricted selection and prospective offers using the existing Contribution system. Migration 23 implements scoped task templates with preserved manual recognition and earned history; migration 26 adds upper-level completion routing. Full browser/runtime evidence belongs in STATUS. Per-role offers within one task remain a separate refinement.
3. Complete minimum useful links/image/PDF materials and retention controls; avoid expanding attachments into a separate document-management project. Migrations 24–25 add [shared task links, photos and PDFs](WORK_MATERIALS.md) using current Work scope, hidden pending reservations, bounded reconstruction, private publication/download and expiry. Current managers publish/remove shared files; current readers download. Private text completion reports remain distinct. Monitored physical cleanup and production parser hardening remain release work.
4. Migration 27 adds the thin event wrapper with a fixed once-per-event combination policy and canonical occurrence claims. Rescheduling/reminders and configurable distinct-role combinations remain separate refinements.
5. Resume remaining V1 communication/delivery, reporting, governance and identity/privacy work. Mobile follows stable web contracts.

Acceptance uses synthetic participation plus practical support: voluntary signup, group-to-region oversight, unverified/returned claims, independent confirmation, different approved templates, manual recognition, no self-approval, expired/revoked authority, concurrent capacity, retries, policy edits after signup, caps, duplicate attendance prevention and compensating corrections. Existing tests are baseline evidence, not validation of these planned extensions.
