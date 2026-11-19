import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { testWorkOversight } from "./work-oversight-tests";
import { SecurityService } from "../backend/src/services/security";

export async function testWorkEditing({
  command,
  act,
  detail,
  owner,
  access,
  check,
  denied,
  sessions,
  collective,
}: Parameters<typeof testWorkOversight>[0] & {
  sessions?: any[];
  collective: (i: number, op: any, input?: object) => Promise<any>;
}) {
  const org = access.organizationId,
    region = access.accounts[2].unitId;
  const future = (hours: number) =>
    new Date(Date.now() + hours * 3600000).toISOString();
  let offer: string | null = null;
  const create = (unitId = region, i = 2) =>
    command(i, "create", {
      key: randomUUID(),
      unitId,
      title: "Synthetic editable task",
      description: "Original instructions",
      roleLabel: "Participant",
      priority: "normal",
      capacity: 3,
      deadline: future(12),
      startsAt: null,
      location: "",
      contributionRuleId: offer,
    });
  const definition = (d: any) => ({
    title: d.title,
    description: d.description,
    priority: d.priority,
    capacity: d.capacity,
    deadline: d.deadline,
    startsAt: d.startsAt ?? null,
    location: d.location ?? "",
    note: "Synthetic correction",
  });
  const task = await create();
  const edit = async (extra: object = {}, id = task.id, i = 2) =>
    act(i, "edit", id, { ...definition(await detail(i, id)), ...extra });
  await check(
    "editing persists shared history and notices while enforcing scope and strict fields",
    async () => {
      const before = await detail(2, task.id),
        input = {
          id: task.id,
          version: before.version,
          key: randomUUID(),
          ...definition(before),
          title: "Updated synthetic task",
        };
      await denied(command(4, "edit", input));
      await denied(
        command(2, "edit", { ...input, organizationId: randomUUID() }),
      );
      for (const extra of [
        { unitId: region },
        { contributionRuleId: randomUUID() },
        { roleLabel: "Other" },
        { title: " " },
        { note: "" },
        { startsAt: future(20) },
        { capacity: 0 },
      ])
        await denied(command(2, "edit", { ...input, ...extra }), 400);
      await command(2, "edit", input);
      const after = await detail(3, task.id);
      assert.equal(after.title, input.title);
      assert.equal(after.version, before.version + 1);
      assert.ok(after.unread > before.unread);
      const event = after.events.find((e: any) => e.action === "edit");
      assert.equal(event.details.before.title, before.title);
      assert.equal(event.details.after.title, input.title);
      assert.equal(event.note, input.note);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM work_commands WHERE organization_id=$1 AND work_id=$2 AND operation='edit'",
            [org, task.id],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    "concurrent exact retries change once; competing stale writes conflict",
    async () => {
      const before = await detail(2, task.id),
        input = {
          id: task.id,
          version: before.version,
          key: randomUUID(),
          ...definition(before),
          description: "Updated instructions",
        };
      const [a, b] = await Promise.all([
        command(2, "edit", input),
        command(2, "edit", input),
      ]);
      assert.deepEqual(a, b);
      assert.equal(a.version, before.version + 1);
      await denied(
        command(2, "edit", { ...input, title: "Different payload" }),
        409,
      );
      await denied(command(2, "edit", { ...input, key: randomUUID() }), 409);
      await denied(edit(), 400);
    },
  );
  await check(
    "capacity and deadlines respect delegated allocations and need definitions",
    async () => {
      const root = await create(access.accounts[0].unitId, 0);
      const child = await act(0, "delegate", root.id, {
        unitId: region,
        ...definition(await detail(0, root.id)),
        roleLabel: "Participant",
        capacity: 2,
        deadline: future(8),
      });
      await denied(edit({ title: "Offered task amendment" }, child.id), 409);
      await act(2, "accept", child.id, { capacity: 2 });
      await denied(edit({ capacity: 3 }, child.id), 409);
      await denied(edit({ deadline: future(16) }, child.id), 409);
      await denied(edit({ capacity: 1 }, root.id, 0), 409);
      await denied(edit({ deadline: future(4) }, root.id, 0), 409);
      await edit(
        { title: "Regional operational correction", deadline: future(9) },
        child.id,
      );
      await act(2, "need_create", task.id, {
        kind: "people",
        title: "Synthetic transport helpers",
        quantity: "3",
        unitLabel: "people",
        gate: "optional",
        memberId: access.accounts[2].memberId,
        deadline: future(6),
        qualificationIds: [],
      });
      await denied(edit({ capacity: 2 }), 409);
      await denied(edit({ deadline: future(5) }), 409);
      await edit({
        capacity: 4,
        deadline: future(14),
        location: "Synthetic meeting point",
      });
    },
  );
  await check(
    "verified Activity and pinned contribution source survive amendments; closed tasks reject new edits",
    async () => {
      const proposal = await collective(0, "propose", {
        key: randomUUID(),
        unitId: access.accounts[0].unitId,
        kind: "points_rule",
        parameters: {
          category: "task",
          ruleVersion: 0,
          amount: 17,
          enabled: true,
          memberMonthCap: 100000,
          issuerMonthCap: 100000,
        },
        reason: "Synthetic editing reward",
        deadline: future(24),
      });
      await collective(1, "vote", {
        key: randomUUID(),
        id: proposal.id,
        version: (await collective(1, "detail", { id: proposal.id })).version,
        choice: "approve",
        reason: "Independent policy review",
      });
      offer = (await collective(0, "points")).rules.find(
        (r: any) => r.category === "task",
      ).id;
      const completed = await create(),
        id = completed.id,
        memberId = access.accounts[3].memberId;
      await act(3, "apply", id);
      await act(2, "assign", id, { memberId });
      await act(3, "start", id);
      await act(3, "submit", id);
      await act(0, "verify", id, { memberId });
      const snapshot = async () =>
        (
          await owner.query(
            "SELECT (SELECT jsonb_agg(to_jsonb(a)) FROM work_assignments a WHERE organization_id=$1 AND work_id=$2) assignments,(SELECT jsonb_agg(to_jsonb(a)) FROM activity_entries a WHERE organization_id=$1) activity,(SELECT jsonb_agg(to_jsonb(e)) FROM contribution_entries e WHERE organization_id=$1) points,(SELECT contribution_rule_id FROM work_items WHERE organization_id=$1 AND id=$2) offer",
            [org, id],
          )
        ).rows;
      const before = await snapshot();
      assert.equal(before[0].points.length, 1);
      assert.equal(before[0].activity.length, 1);
      assert.equal(before[0].offer, offer);
      const d = await detail(2, id),
        input = {
          id,
          version: d.version,
          key: randomUUID(),
          ...definition(d),
          description: "Clarified after verification",
        };
      const saved = await command(2, "edit", input);
      assert.deepEqual(await snapshot(), before);
      await act(2, "complete", id);
      await denied(edit({ title: "Closed amendment" }, id), 409);
      assert.deepEqual(await command(2, "edit", input), saved);
    },
  );
  await check(
    "unchanged overdue deadline allows corrections and explicit future extension reopens enrollment",
    async () => {
      const late = await create();
      await owner.query(
        "UPDATE work_items SET deadline=clock_timestamp()-interval '1 minute' WHERE organization_id=$1 AND id=$2",
        [org, late.id],
      );
      await edit({ location: "Corrected meeting place" }, late.id);
      await denied(act(3, "apply", late.id), 409);
      await edit({ deadline: future(4) }, late.id);
      await act(3, "apply", late.id);
    },
  );
  await check(
    "audit failure rolls back amendments, notices, history and receipts",
    async () => {
      const before = await detail(2, task.id),
        key = randomUUID();
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic audit outage");
      };
      try {
        await assert.rejects(
          command(2, "edit", {
            id: task.id,
            version: before.version,
            key,
            ...definition(before),
            title: "Must roll back",
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.deepEqual(await detail(2, task.id), before);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM work_commands WHERE organization_id=$1 AND key=$2",
            [org, key],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await check(
    "authority expiring during audit rolls back an already executed edit",
    async () => {
      const grants = (
        await owner.query(
          "SELECT id,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, access.accounts[2].memberId],
        )
      ).rows;
      const before = await detail(2, task.id),
        original = SecurityService.logAuditEventInTransaction;
      let reached = false,
        expires: Date;
      try {
        expires = (
          await owner.query(
            "UPDATE memberships SET valid_until=clock_timestamp()+interval '8 seconds' WHERE id=ANY($1::uuid[]) RETURNING valid_until",
            [grants.map((g) => g.id)],
          )
        ).rows[0].valid_until;
        SecurityService.logAuditEventInTransaction = async (
          client,
          ...rest
        ) => {
          assert.equal(rest[1].operation, "edit");
          assert.equal(rest[1].changed, true);
          reached = true;
          await original.call(SecurityService, client, ...rest);
          await client.query(
            "SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.1)",
            [expires],
          );
        };
        await denied(
          command(2, "edit", {
            id: task.id,
            version: before.version,
            key: randomUUID(),
            ...definition(before),
            title: "Expired authority edit",
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
      assert.equal(reached, true);
      assert.deepEqual(await detail(2, task.id), before);
    },
  );
  await check(
    "HTTP edits require CSRF, current manager scope and strict payloads",
    async () => {
      assert.ok(sessions);
      const d = await detail(2, task.id),
        input = {
          organizationId: org,
          id: task.id,
          version: d.version,
          key: randomUUID(),
          ...definition(d),
          title: "HTTP task amendment",
        };
      const post = (i: number) =>
        sessions[i].agent
          .post("/api/v1/admin/work/edit")
          .set("Origin", "http://localhost:15173");
      await post(2).send(input).expect(403);
      await post(4)
        .set("X-Admin-Csrf", sessions[4].csrf)
        .send(input)
        .expect(403);
      await post(2)
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send({ ...input, eventId: randomUUID() })
        .expect(400);
      await post(2)
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send(input)
        .expect("Cache-Control", "no-store")
        .expect(200);
    },
  );
  await check(
    "changed deadline expiring during audit rolls back; moved ancestry denies editing",
    async () => {
      const fresh = await create(),
        before = await detail(2, fresh.id),
        original = SecurityService.logAuditEventInTransaction;
      const due = new Date(Date.now() + 3000).toISOString();
      let reached = false;
      SecurityService.logAuditEventInTransaction = async (client, ...rest) => {
        assert.equal(rest[1].changed, true);
        reached = true;
        await original.call(SecurityService, client, ...rest);
        await client.query(
          "SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.1)",
          [due],
        );
      };
      try {
        await denied(
          command(2, "edit", {
            id: fresh.id,
            key: randomUUID(),
            version: before.version,
            ...definition(before),
            deadline: due,
          }),
          409,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal(reached, true);
      assert.deepEqual(await detail(2, fresh.id), before);
      const parent = (
        await owner.query(
          "SELECT parent_id FROM units WHERE organization_id=$1 AND id=$2",
          [org, region],
        )
      ).rows[0].parent_id;
      try {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, region, access.accounts[4].unitId],
        );
        await denied(
          command(0, "edit", {
            id: fresh.id,
            key: randomUUID(),
            version: before.version,
            ...definition(before),
            title: "Moved ancestry edit",
          }),
        );
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, region, parent],
        );
      }
    },
  );
}
