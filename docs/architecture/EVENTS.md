# Events and confirmed participation

Migration 27 adds a thin event object within Work. The web route is `/events`; API operations use the existing authenticated `/admin/work` router. Events share a title, instructions, optional meeting place, UTC start/end and an immutable reward offer. Registration, capacity, qualifications, materials, funding, conversations and independent completion remain task responsibilities. There is no second attendance or points engine.

## Authority and disclosure

Current `workitem.read` plus `workitem.create` at the event unit permits creation and management. Names of positions do not grant access. Events retain their creation ancestry; a moved hierarchy fails closed. Readers at the event unit can see the shared context. A reader of a linked descendant task can also see that event's shared context, but only their currently readable tasks. This deliberately shares the event title, instructions, time, location and offer with delegated participants. Put restricted operational details in the appropriate task, not in shared event instructions.

Event detail contains no participant directory or hidden task counts. Scoped task projections retain their existing authorized capacity/progress summaries. Regional managers cannot change a parent event merely because one of its tasks is delegated to their region. Sibling and other-organization access is denied. Both task and event scope are checked by the server, including after audit; all responses use no-store.

## Operational flow

1. Open **Events**, choose **Create event**, enter the responsible unit, title, time range, optional instructions/place and an allowed reward offer or **No automatic reward**. Organization is resolved from the current authorized context, without a selector.
2. Open the event and **Add task** for participation, transport or other support. The form reuses its time/place and creates a normal open task. The task screen provides signup, assignments, delegation, materials and confirmation. Additional role labels, qualification/resource requirements and coordination retain their existing task workflows.
3. Delegated tasks automatically inherit event identity and its pinned offer. The event page lists only tasks the viewer can currently read. Browser navigation uses transient state, not protected IDs in URLs.
4. Finish or cancel individual tasks before completing/cancelling the event. Closure never silently changes task states, withdraws participation or reverses earned points. Concurrent creation and closure are serialized. Exact retries return their original result; changed payloads conflict.

An event may contain at most 100 tasks including delegated descendants. Lists are paged at 25 and details are bounded by that task limit. New events must end in the future and within one year. New tasks cannot be linked after event end or closure. Task reporting/verification follows its own deadline policy; event end does not erase outstanding completion reports.

Existing tasks are not retroactively attached, and event invitations/offers are immutable in this slice. This avoids relabeling already accepted participation or retroactively changing rewards. Rescheduling/versioned invitations and event reminders are later work. No automatic geolocation, presence tracking or identity evidence is collected.

## Canonical occurrence and recognition

The first combination policy is deliberately simple: **one automatic event offer per member, on their first independently verified linked task**. All tasks and delegated mirrors share that offer, so verification order cannot select a different amount. Event creation accepts only a currently enabled, independently approved rule permitted at its scope, or explicit no reward. Later rule edits/disabling apply to future events; existing event tasks retain the offer even when added after a newer rule version exists.

The canonical occurrence key is `(organization_id, event_id, user_id)`. A private immutable claim links it to the first verified Activity. Concurrent confirmations can record multiple legitimate task Activity entries but only one claims the event offer. The claim, task verification, Activity, contribution entry and required audit share the same transaction. Failures roll them all back. No client can choose an alternate occurrence identifier or combination policy.

A cap-reached outcome consumes the same occurrence; another task or later accounting period cannot refill it. Reversing an award retains the occurrence claim and cannot cause another linked task to award it again. No-reward events still record Activity and occurrence completion. Ordinary standalone tasks retain their existing per-assignment behavior; old history is not recalculated.

Distinct driving and attendance awards within one event are not stacked in this slice. Independently approved combination/role policies would be required before enabling that refinement. Exceptional manual recognition remains a separate, bounded and independently approved process; it is not an automatic event award. This implementation cannot infer that separately created events or unrelated standalone tasks describe the same real-world occurrence. Operators must use one event for one occurrence and link its operational tasks.

## Validation

`npm run test:events` uses a disposable database for scope and schema boundaries, exact/concurrent retries, pinned offers across policy changes, linked/delegated identity, duplicate awards, no-reward Activity, correction/cap retention, audit rollback, actual authority expiry during audit, moved ancestry and HTTP/CSRF checks. `npm run test:events:browser` additionally creates an event and linked task through real forms, opens it as another regional account, verifies sibling isolation and checks Georgian/English, light/dark and narrow layouts. Unit tests cover authority-driven controls, fixed retry payloads, denied-state recovery and absence of task-level reward overrides. Executed outcomes and local activation belong in [STATUS](../STATUS.md).
