# Hierarchical completion review

Migration 26 applies hierarchical review to Work assignment completion and return for changes. It reuses current memberships, versioned permission grants, task ancestry, assignment state, the inbox and the existing Activity/Contribution transaction. No new role names, service, approval engine or reward calculation is introduced.

## Reviewer selection

An ordinary participant's minimum review unit is the task's unit. A person holding effective `workitem.create` and read authority over that task is treated as a manager in this context. The highest authority-bearing unit on the task's frozen ancestry determines the manager's review floor: its parent, or the root itself when there is no parent. Unrelated management authority in another subtree does not change this task's route.

| Participant in this task | Minimum reviewer authority |
|---|---|
| Ordinary participant | Task unit |
| Group manager acting within that group | Parent unit, normally the region |
| Regional manager acting within the region | Parent unit, normally the council |
| Root manager | Another independent reviewer with root authority |

The reviewer must be a different person, retain explicit `workitem.verify` authority both for the task and its required review unit, and currently be allowed to read the task. A higher ancestor with the applicable subtree grant may act; rank or position names alone do not suffice. The participant must still have read/participation eligibility and satisfy existing qualification gates. Missing eligible reviewers leave the submission pending; there is no self-review, peer fallback below the floor, automatic grant or approval.

The minimum review unit is stored on the assignment when participation starts. Assignment writes retain the stronger of the stored floor and current management authority. Reads and consequential commands also consider current authority, so promotion can immediately raise the floor. Removing management grants cannot lower a floor already recorded on the assignment. These are current/observed authority guarantees, not reconstruction of every historical role change. Migration backfills existing assignments from authority at migration time.

## Consistency and disclosure

Both `verify` and `return` pass the same routing check through `work_authorize`, including the final check after transactional audit. The existing task version, idempotency receipt, organization/advisory locks, independent actor check and qualification validation remain in force. Expiry during audit rolls back completion and Activity/points together. A repeated accepted request cannot create another Activity entry or award. Current authority still governs retries; an earlier receipt grants no continuing authority.

Existing completed work and earned awards are not recalculated or reversed. Existing pending submissions adopt the new routing rule without changing their state or content. New metadata does not confer membership, qualification or any additional permission. Frozen task ancestry prevents moving a task's hierarchy from silently rerouting its review.

Task detail returns a per-assignment `canReview` value and a local/higher route explanation. A broad verifier flag is insufficient to show completion controls. Responses lacking the per-assignment grant fail closed in the web UI. The review unit's name is disclosed only with current `unit.read` at that unit; otherwise the UI gives a generic hierarchy explanation. No reviewer directory or personal identity is exposed.

The shared inbox uses the same predicate for submitted assignments. A regional peer may still monitor a task with their existing read scope, but its completion is not their actionable review. Existing minimal notifications already reach eligible higher-level reviewers. Criteria, qualification verification, resource receipt, financial proposals and manual recognition retain their separate existing authorization and independence rules; this migration does not claim to redefine those workflows or make them completion approvals.

## Validation and operation

Apply the local migration using the normal migration command; no demo reseed is required. Open **Tasks → task → Participants and progress** to see the confirmation route. Eligible reviewers use **Inbox → Needs my action** or the task's per-participant **Verify completion / Return for changes** actions. At the root, another eligible root reviewer must act.

Run `npm run test:work-review` for disposable database/HTTP cases and `npm run test:work-review:browser` for peer, council and participant browser journeys. The focused checks cover ordinary participation, group/region/root review, promotion, pinned floors after demotion, sibling denial, exact concurrent retries, inbox routing, post-mutation permission expiry, Activity rollback and strict HTTP/CSRF boundaries. The full Work, inbox and task-conversation regressions cover the surrounding flows. Current outcomes are in [STATUS](../STATUS.md); production identity/MFA/audit gates and event reward deduplication remain separate.
