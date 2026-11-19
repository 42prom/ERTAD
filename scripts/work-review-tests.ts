import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SecurityService } from "../backend/src/services/security";

export async function testWorkReview({
  command,
  detail,
  act,
  owner,
  access,
  check,
  denied,
  sessions,
}: any) {
  const org = access.organizationId,
    unit = access.accounts[2].unitId,
    member = (i: number) => access.accounts[i].memberId;
  const create = async (target = unit) =>
    (
      await command(2, "create", {
        key: randomUUID(),
        unitId: target,
        title: "Synthetic hierarchy review",
        description: "Independent completion confirmation",
        roleLabel: "Participant",
        priority: "normal",
        capacity: 3,
        deadline: new Date(Date.now() + 86400000).toISOString(),
        contributionRuleId: null,
      })
    ).id;
  const submit = async (i: number, id: string) => {
    await act(i, "apply", id);
    await act(2, "assign", id, { memberId: member(i) });
    await act(i, "start", id);
    await act(i, "submit", id);
  };
  const assignment = async (i: number, id: string, subject: number) =>
    (await detail(i, id)).assignments.find(
      (a: any) => a.memberId === member(subject),
    );
  const authority = (
    await owner.query(
      "SELECT id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
      [org, member(3)],
    )
  ).rows.map((r: any) => r.id);
  async function limitedMembership(
    subject: number,
    target = unit,
    manage = false,
  ) {
    const bundle = randomUUID(),
      position = randomUUID();
    await owner.query(
      "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
      [org, bundle],
    );
    for (const grant of [
      "unit.read",
      "workitem.read",
      "workitem.participate",
      ...(manage ? ["workitem.create", "workitem.verify"] : []),
    ])
      await owner.query(
        "INSERT INTO permission_grants VALUES($1,$2,1,$3,'subtree')",
        [org, bundle, grant],
      );
    await owner.query(
      "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
      [org, bundle],
    );
    await owner.query(
      "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic scoped participant',$4,1)",
      [org, position, target, bundle],
    );
    return (
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day') RETURNING id",
        [org, member(subject), target, position],
      )
    ).rows[0].id;
  }
  await check(
    "ordinary participants use local independent verification without gaining authority",
    async () => {
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
        [authority],
      );
      await limitedMembership(3);
      const id = await create();
      await submit(3, id);
      assert.equal((await assignment(2, id, 3)).canReview, true);
      assert.equal((await assignment(3, id, 3)).reviewRoute, "local");
      await denied(act(3, "verify", id, { memberId: member(3) })); // no verifier grant
      await act(2, "verify", id, { memberId: member(3) });
      assert.equal((await assignment(2, id, 3)).status, "verified");
      assert.equal((await detail(3, id)).canManage, false);
    },
  );
  await check(
    "group manager contribution routes to the parent region, not a role-name bypass",
    async () => {
      const group = randomUUID();
      await owner.query(
        "INSERT INTO units(organization_id,id,parent_id,name,kind) VALUES($1,$2,$3,'Synthetic review group','authority')",
        [org, group, unit],
      );
      await limitedMembership(3, group, true);
      const id = await create(group);
      await submit(3, id);
      assert.equal((await assignment(3, id, 3)).reviewRoute, "higher");
      assert.equal((await assignment(2, id, 3)).canReview, true);
      await act(2, "verify", id, { memberId: member(3) });
    },
  );
  await check(
    "promotion after volunteering raises the review floor and later demotion cannot undo it",
    async () => {
      const id = await create();
      await submit(3, id);
      assert.equal((await assignment(2, id, 3)).canReview, true);
      await owner.query(
        "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
        [authority],
      );
      await denied(act(2, "verify", id, { memberId: member(3) }));
      assert.equal((await assignment(0, id, 3)).canReview, true);
      await act(0, "return", id, {
        memberId: member(3),
        note: "Synthetic promoted-manager review",
      });
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
        [authority],
      );
      await act(3, "submit", id);
      await denied(act(2, "verify", id, { memberId: member(3) }));
      await act(0, "verify", id, { memberId: member(3) });
      await owner.query(
        "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
        [authority],
      );
    },
  );
  await check(
    "regional peers cannot verify or return manager participation; council receives actionable review",
    async () => {
      const id = await create();
      await submit(2, id);
      assert.equal((await assignment(3, id, 2)).canReview, false);
      assert.equal((await assignment(0, id, 2)).canReview, true);
      assert.equal((await assignment(2, id, 2)).reviewRoute, "higher");
      assert.equal((await assignment(3, id, 2)).reviewUnitName, null);
      await denied(act(3, "verify", id, { memberId: member(2) }));
      await denied(
        act(3, "return", id, { memberId: member(2), note: "Synthetic return" }),
      );
      await denied(act(4, "verify", id, { memberId: member(2) }));
      const actions = (
        await owner.query(
          "SELECT ertad.inbox_work_action($1,w) AS peer,ertad.inbox_work_action($2,w) AS council FROM work_items w WHERE id=$3",
          [member(3), member(0), id],
        )
      ).rows[0];
      assert.equal(actions.peer, "");
      assert.equal(actions.council, "verify");
      await act(0, "return", id, {
        memberId: member(2),
        note: "Please complete the instructions",
      });
      await act(2, "submit", id);
      const input = {
        id,
        key: randomUUID(),
        version: (await detail(0, id)).version,
        memberId: member(2),
      };
      const results = await Promise.all([
        command(0, "verify", input),
        command(0, "verify", input),
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(
        Number(
          (
            await owner.query(
              "SELECT count(*) FROM activity_entries e JOIN work_assignments a ON a.organization_id=e.organization_id AND a.id=e.assignment_id WHERE a.work_id=$1",
              [id],
            )
          ).rows[0].count,
        ),
        1,
      );
    },
  );
  await check(
    "root-level managers require another independently authorized root reviewer",
    async () => {
      const id = await create();
      await submit(0, id);
      await denied(act(0, "verify", id, { memberId: member(0) }), 409);
      await denied(act(2, "verify", id, { memberId: member(0) }));
      assert.equal((await assignment(1, id, 0)).canReview, true);
      await act(1, "verify", id, { memberId: member(0) });
    },
  );
  await check(
    "removing management authority cannot lower a pinned review floor",
    async () => {
      const id = await create();
      await submit(2, id);
      const original = (
        await owner.query(
          "SELECT id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, member(2)],
        )
      ).rows.map((r: any) => r.id);
      const limited = await limitedMembership(2);
      try {
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
          [original],
        );
        await denied(act(3, "verify", id, { memberId: member(2) }));
        assert.equal((await assignment(0, id, 2)).reviewRoute, "higher");
        await act(0, "return", id, {
          memberId: member(2),
          note: "Synthetic independent return",
        });
        await act(2, "submit", id);
        await denied(act(3, "verify", id, { memberId: member(2) }));
        await act(0, "verify", id, { memberId: member(2) });
      } finally {
        await owner.query(
          "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
          [original],
        );
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE id=$1",
          [limited],
        );
      }
    },
  );
  await check(
    "scope movement and reviewer expiry during audit roll back completion and Activity",
    async () => {
      const id = await create();
      await submit(2, id);
      const grants = (
        await owner.query(
          "SELECT id,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, member(0)],
        )
      ).rows;
      const version = (await detail(1, id)).version;
      let auditReached = false;
      let expiresAt: Date;
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (client, ...rest) => {
        assert.equal(rest[0], "WORK_COMMAND");
        assert.equal(rest[1].operation, "verify");
        assert.equal(rest[1].changed, true);
        auditReached = true;
        await original.call(SecurityService, client, ...rest);
        // This synthetic audit waits past a 10s grant deadline. Only this transaction
        // gets 15s so the production 10s query guard cannot mask the expiry assertion.
        await client.query("SET LOCAL statement_timeout='15s'");
        await client.query(
          "SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.1)",
          [expiresAt],
        );
      };
      try {
        const changed = await owner.query(
          "UPDATE ertad.memberships SET valid_until=clock_timestamp()+interval '10 seconds' WHERE id=ANY($1::uuid[]) RETURNING valid_until",
          [grants.map((g: any) => g.id)],
        );
        expiresAt = new Date(
          Math.max(
            ...changed.rows.map((g: any) => new Date(g.valid_until).getTime()),
          ),
        );
        await denied(
          command(0, "verify", {
            id,
            key: randomUUID(),
            version,
            memberId: member(2),
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        for (const g of grants)
          await owner.query(
            "UPDATE memberships SET valid_until=$2 WHERE id=$1",
            [g.id, g.valid_until],
          );
      }
      assert.equal((await assignment(0, id, 2)).status, "submitted");
      assert.equal(
        auditReached,
        true,
        "Expiry must happen after mutation, during audit",
      );
      assert.equal(
        Number(
          (
            await owner.query(
              "SELECT count(*) FROM activity_entries e JOIN work_assignments a ON a.organization_id=e.organization_id AND a.id=e.assignment_id WHERE a.work_id=$1",
              [id],
            )
          ).rows[0].count,
        ),
        0,
      );
      const parent = (
        await owner.query(
          "SELECT parent_id FROM units WHERE organization_id=$1 AND id=$2",
          [org, unit],
        )
      ).rows[0].parent_id;
      try {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, unit, access.accounts[4].unitId],
        );
        await denied(act(0, "verify", id, { memberId: member(2) }));
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, unit, parent],
        );
      }
    },
  );
  await check(
    "HTTP completion commands enforce routing, CSRF and strict payloads",
    async () => {
      const id = await create();
      await submit(2, id);
      const input = {
          organizationId: org,
          id,
          key: randomUUID(),
          version: (await detail(0, id)).version,
          memberId: member(2),
        },
        origin = "http://localhost:15173";
      await sessions[0].agent
        .post("/api/v1/admin/work/verify")
        .set("Origin", origin)
        .send(input)
        .expect(403);
      await sessions[3].agent
        .post("/api/v1/admin/work/verify")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[3].csrf)
        .send(input)
        .expect(403);
      await sessions[0].agent
        .post("/api/v1/admin/work/verify")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[0].csrf)
        .send({ ...input, reviewUnitId: unit })
        .expect(400);
      await sessions[0].agent
        .post("/api/v1/admin/work/verify")
        .set("Origin", origin)
        .set("X-Admin-Csrf", sessions[0].csrf)
        .send(input)
        .expect(200);
    },
  );
}
