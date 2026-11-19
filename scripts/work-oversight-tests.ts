import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { DemoAccess } from "../backend/src/localDemo";
import type { WorkOperation } from "../backend/src/modules/work/tasks";
import { SecurityService } from "../backend/src/services/security";

export async function testWorkOversight({
  command,
  act,
  detail,
  owner,
  access,
  check,
  denied,
}: {
  command: (i: number, op: WorkOperation, input?: object) => Promise<any>;
  act: (
    i: number,
    op: WorkOperation,
    id: string,
    extra?: object,
  ) => Promise<any>;
  detail: (i: number, id: string) => Promise<any>;
  owner: pg.Client;
  access: DemoAccess;
  check: (name: string, fn: () => Promise<void>) => Promise<void>;
  denied: (p: Promise<unknown>, status?: number) => Promise<void>;
}) {
  const org = access.organizationId,
    a = access.accounts[2].unitId,
    b = access.accounts[4].unitId;
  const fresh = (unitId = a) => ({
    key: randomUUID(),
    unitId,
    capacity: 2,
    title: "Synthetic oversight task",
    description: "Synthetic operational evidence",
    roleLabel: "Coordinator",
    priority: "normal",
    deadline: new Date(Date.now() + 3600000).toISOString(),
  });
  const criteria = () => [
    { id: randomUUID(), title: "Prepare the venue", weight: 1 },
    { id: randomUUID(), title: "Deliver the event", weight: 3 },
  ];
  const audit = SecurityService.logAuditEventInTransaction;
  await check(
    "weighted verified outcomes, frozen criteria and independent review allow criteria-only completion",
    async () => {
      const id = (await command(2, "create", fresh())).id,
        c = criteria();
      await act(2, "criteria", id, { criteria: c });
      assert.equal((await detail(2, id)).verifiedProgress, 0);
      await act(2, "criterion_submit", id, {
        criterionId: c[0].id,
        note: "Venue checked with synthetic evidence",
      });
      await denied(
        act(2, "criterion_verify", id, {
          criterionId: c[0].id,
          note: "Self approval forbidden",
        }),
      );
      const input = {
        id,
        key: randomUUID(),
        version: (await detail(3, id)).version,
        criterionId: c[0].id,
        note: "Independent check complete",
      };
      const result = await command(3, "criterion_verify", input);
      assert.deepEqual(await command(3, "criterion_verify", input), result);
      assert.equal((await detail(2, id)).verifiedProgress, 25);
      await denied(act(2, "complete", id), 409);
      await denied(
        act(2, "cancel", id, { note: "Cannot erase a verified outcome" }),
        409,
      );
      await denied(act(2, "criteria", id, { criteria: criteria() }), 409);
      await act(2, "criterion_submit", id, {
        criterionId: c[1].id,
        note: "First result",
      });
      await act(3, "criterion_return", id, {
        criterionId: c[1].id,
        note: "More evidence needed",
      });
      await denied(act(2, "criteria", id, { criteria: criteria() }), 409);
      await act(2, "criterion_submit", id, {
        criterionId: c[1].id,
        note: "Additional evidence",
      });
      await act(3, "criterion_verify", id, {
        criterionId: c[1].id,
        note: "Independent final check",
      });
      assert.equal((await detail(2, id)).verifiedProgress, 100);
      await act(3, "complete", id);
      assert.equal((await detail(2, id)).status, "completed");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM activity_entries e JOIN work_assignments a ON a.organization_id=e.organization_id AND a.id=e.assignment_id WHERE a.work_id=$1",
            [id],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await check(
    "coordinator choices are scoped and cannot assign an ancestor or sibling manager",
    async () => {
      const id = (await command(2, "create", fresh())).id,
        d = await detail(2, id);
      assert.equal(d.coordinatorId, access.accounts[2].memberId);
      assert.ok(d.coordinators.includes(access.accounts[3].memberId));
      assert.ok(!d.coordinators.includes(access.accounts[0].memberId));
      assert.ok(!d.coordinators.includes(access.accounts[4].memberId));
      await denied(
        act(2, "coordinator", id, { memberId: access.accounts[4].memberId }),
      );
      await denied(
        act(2, "coordinator", id, { memberId: access.accounts[0].memberId }),
      );
      await act(2, "coordinator", id, {
        memberId: access.accounts[3].memberId,
      });
      assert.equal(
        (await detail(2, id)).coordinatorId,
        access.accounts[3].memberId,
      );
      const saved = (
        await owner.query(
          "SELECT id,status FROM memberships WHERE organization_id=$1 AND user_id=$2",
          [org, access.accounts[3].memberId],
        )
      ).rows;
      try {
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE organization_id=$1 AND user_id=$2",
          [org, access.accounts[3].memberId],
        );
        assert.equal((await detail(2, id)).coordinatorActive, false);
        assert.ok((await command(2, "overview")).unowned > 0);
        await denied(
          act(2, "block", id, {
            kind: "dependency",
            note: "Owner is unavailable",
            nextReviewAt: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
      } finally {
        for (const row of saved)
          await owner.query("UPDATE memberships SET status=$2 WHERE id=$1", [
            row.id,
            row.status,
          ]);
      }
    },
  );
  await check(
    "blockers prevent completion, have exact retries, and appear only in authorized oversight",
    async () => {
      const parent = (
        await command(0, "create", fresh(access.accounts[0].unitId))
      ).id;
      const id = (
        await act(0, "delegate", parent, {
          ...fresh(),
          deadline: new Date((await detail(0, parent)).deadline).toISOString(),
        })
      ).id;
      await act(2, "accept", id, { capacity: 2 });
      assert.equal(
        (await detail(2, id)).coordinatorId,
        access.accounts[2].memberId,
      );
      const c = criteria();
      await act(2, "criteria", id, { criteria: [c[0]] });
      await act(2, "criterion_submit", id, {
        criterionId: c[0].id,
        note: "Work ready",
      });
      await act(3, "criterion_verify", id, {
        criterionId: c[0].id,
        note: "Result checked",
      });
      const input = {
        id,
        key: randomUUID(),
        version: (await detail(2, id)).version,
        kind: "funding",
        note: "Funding reconciliation required",
        nextReviewAt: new Date(Date.now() + 3600000).toISOString(),
      };
      await command(2, "block", input);
      await command(2, "block", input);
      const d = await detail(2, id);
      assert.equal(d.blockerRecords.length, 1);
      assert.equal((await detail(0, parent)).overview.blocked, 1);
      assert.equal((await detail(0, parent)).overview.leafTotal, 1);
      await denied(act(2, "complete", id), 409);
      await denied(command(4, "overview", { unitId: a }));
      await denied(command(4, "list", { view: "blocked", unitId: a }));
      assert.ok(
        (await command(2, "list", { view: "blocked", unitId: a })).items.some(
          (w: any) => w.id === id,
        ),
      );
      assert.equal((await command(4, "list", { view: "blocked" })).total, 0);
      await owner.query(
        "UPDATE work_blockers SET next_review_at=clock_timestamp()-interval '1 second' WHERE work_id=$1",
        [id],
      );
      assert.ok((await command(2, "overview")).reviewDue > 0);
      await act(2, "block_update", id, {
        blockerId: d.blockerRecords[0].id,
        memberId: access.accounts[3].memberId,
        nextReviewAt: new Date(Date.now() + 3600000).toISOString(),
        note: "Regional manager 2 will reconcile the equipment",
      });
      const updated = (await detail(2, id)).blockerRecords[0];
      assert.equal(updated.ownerId, access.accounts[3].memberId);
      assert.equal(updated.reason, input.note);
      assert.match(updated.nextAction, /reconcile/);
      await denied(
        act(2, "block_update", id, {
          blockerId: updated.id,
          memberId: access.accounts[4].memberId,
          nextReviewAt: new Date(Date.now() + 3600000).toISOString(),
          note: "Cannot assign another region",
        }),
      );
      await act(3, "resolve_block", id, {
        blockerId: d.blockerRecords[0].id,
        note: "Reconciliation reviewed",
      });
      await act(3, "complete", id);
      await act(0, "complete", parent);
      const summary = (await detail(0, parent)).overview;
      assert.equal(summary.leafCompleted, 1);
      assert.equal(summary.leafTotal, 1);
    },
  );
  await check(
    "criteria validation is enforced at HTTP schema and SQL boundaries",
    async () => {
      const id = (await command(2, "create", fresh())).id;
      await denied(
        act(2, "criteria", id, {
          criteria: [{ id: randomUUID(), title: "Invalid weight", weight: 0 }],
        }),
        400,
      );
      await denied(
        act(2, "criteria", id, {
          criteria: Array.from({ length: 11 }, () => criteria()[0]),
        }),
        400,
      );
      await act(2, "criteria", id, { criteria: criteria() });
      await act(2, "apply", id);
      await denied(act(2, "criteria", id, { criteria: criteria() }), 409);
      const empty = (await command(2, "create", fresh())).id;
      await owner.query("BEGIN");
      try {
        await assert.rejects(
          owner.query(
            "SELECT work_tracking_change($1,w,'criteria',$3::jsonb) FROM work_items w WHERE id=$2",
            [
              access.accounts[2].memberId,
              empty,
              JSON.stringify({
                criteria: [
                  { id: randomUUID(), title: "Invalid decimal", weight: 1.5 },
                ],
              }),
            ],
          ),
          (e: any) => e.code === "22023",
        );
      } finally {
        await owner.query("ROLLBACK");
      }
    },
  );
  await check(
    "new outcomes and blockers roll back when strict audit fails",
    async () => {
      const id = (await command(2, "create", fresh())).id,
        c = criteria()[0];
      await act(2, "criteria", id, { criteria: [c] });
      await act(2, "criterion_submit", id, {
        criterionId: c.id,
        note: "Result ready for verification",
      });
      const version = (await detail(3, id)).version;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic oversight audit failure");
      };
      try {
        await assert.rejects(
          command(3, "criterion_verify", {
            id,
            key: randomUUID(),
            version,
            criterionId: c.id,
            note: "Independent review",
          }),
          /Synthetic oversight audit failure/,
        );
        await assert.rejects(
          command(2, "block", {
            id,
            key: randomUUID(),
            version,
            kind: "resource",
            note: "Equipment unavailable",
            nextReviewAt: new Date(Date.now() + 3600000).toISOString(),
          }),
          /Synthetic oversight audit failure/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      const d = await detail(3, id);
      assert.equal(d.version, version);
      assert.equal(d.criteria[0].status, "submitted");
      assert.equal(d.blockers, 0);
    },
  );
  await check(
    "submitter eligibility is checked again after verification audit",
    async () => {
      const id = (await command(2, "create", fresh())).id,
        c = criteria()[0];
      await act(2, "criteria", id, { criteria: [c] });
      await act(2, "criterion_submit", id, {
        criterionId: c.id,
        note: "Result ready",
      });
      const version = (await detail(3, id)).version,
        saved = (
          await owner.query(
            "SELECT id,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2",
            [org, access.accounts[2].memberId],
          )
        ).rows;
      await owner.query(
        "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE organization_id=$1 AND user_id=$2",
        [org, access.accounts[2].memberId],
      );
      SecurityService.logAuditEventInTransaction = async (
        ...args: Parameters<typeof audit>
      ) => {
        await new Promise((r) => setTimeout(r, 2200));
        return audit(...args);
      };
      try {
        await denied(
          command(3, "criterion_verify", {
            id,
            key: randomUUID(),
            version,
            criterionId: c.id,
            note: "Independent verification",
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
        for (const row of saved)
          await owner.query(
            "UPDATE memberships SET valid_until=$2 WHERE id=$1",
            [row.id, row.valid_until],
          );
      }
      assert.equal((await detail(3, id)).criteria[0].status, "submitted");
    },
  );
  await check(
    "unit-only observers cannot infer hidden child work through aggregate counters",
    async () => {
      const group = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 ORDER BY id LIMIT 1",
          [org, a],
        )
      ).rows[0].id;
      const parent = (await command(2, "create", fresh())).id;
      const child = (
        await act(2, "delegate", parent, {
          ...fresh(group),
          deadline: new Date((await detail(2, parent)).deadline).toISOString(),
        })
      ).id;
      await act(2, "accept", child, { capacity: 2 });
      await act(2, "block", child, {
        kind: "resource",
        note: "Hidden child resource shortfall",
        nextReviewAt: new Date(Date.now() + 3600000).toISOString(),
      });
      const saved = (
        await owner.query(
          "SELECT id,status FROM memberships WHERE organization_id=$1 AND user_id=$2",
          [org, access.accounts[4].memberId],
        )
      ).rows;
      const bundle = randomUUID(),
        position = randomUUID();
      let mid: string | undefined;
      try {
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE organization_id=$1 AND user_id=$2",
          [org, access.accounts[4].memberId],
        );
        await owner.query(
          "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
          [org, bundle],
        );
        await owner.query(
          "INSERT INTO permission_grants VALUES($1,$2,1,'workitem.read','unit')",
          [org, bundle],
        );
        await owner.query(
          "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
          [org, bundle],
        );
        await owner.query(
          "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic work observer',$4,1)",
          [org, position, a, bundle],
        );
        mid = (
          await owner.query(
            "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day') RETURNING id",
            [org, access.accounts[4].memberId, a, position],
          )
        ).rows[0].id;
        const visible = await detail(4, parent);
        assert.equal(visible.overview.total, 1);
        assert.equal(visible.overview.leafTotal, 1);
        assert.equal(visible.overview.blocked, 0);
        assert.deepEqual(visible.children, []);
        assert.deepEqual(visible.coordinators, []);
        await denied(detail(4, child));
        await denied(
          act(4, "block", parent, {
            kind: "other",
            note: "Read access is insufficient",
            nextReviewAt: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
        assert.ok((await detail(2, parent)).overview.blocked > 0);
      } finally {
        if (mid)
          await owner.query(
            "UPDATE memberships SET status='suspended' WHERE id=$1",
            [mid],
          );
        for (const row of saved)
          await owner.query("UPDATE memberships SET status=$2 WHERE id=$1", [
            row.id,
            row.status,
          ]);
      }
    },
  );
}
