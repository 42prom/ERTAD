import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SecurityService } from "../backend/src/services/security";

export async function testEvents({
  command,
  collective,
  act,
  detail,
  owner,
  access,
  check,
  denied,
  sessions,
}: any) {
  const org = access.organizationId,
    root = access.accounts[0].unitId,
    region = access.accounts[2].unitId,
    sibling = access.accounts[4].unitId;
  const starts = () => new Date(Date.now() + 60000).toISOString(),
    ends = () => new Date(Date.now() + 86400000).toISOString();
  const create = (i = 2, extra: object = {}) =>
    command(i, "event_create", {
      key: randomUUID(),
      unitId: region,
      title: "Synthetic event",
      description: "Voluntary participation and support",
      startsAt: starts(),
      endsAt: ends(),
      location: "Synthetic meeting place",
      contributionRuleId: null,
      ...extra,
    });
  const event = (i: number, id: string) => command(i, "event_detail", { id });
  const task = (eventId: string, i = 2, extra: object = {}) =>
    command(i, "create", {
      key: randomUUID(),
      eventId,
      unitId: region,
      title: "Synthetic event task",
      roleLabel: "Participant",
      priority: "normal",
      capacity: 4,
      deadline: ends(),
      ...extra,
    });
  const close = (
    i: number,
    id: string,
    op = "event_complete",
    extra: object = {},
  ) =>
    command(i, op, { id, key: randomUUID(), version: 1, note: "", ...extra });
  const submit = async (id: string, i = 3) => {
    await act(i, "apply", id);
    await act(2, "assign", id, { memberId: access.accounts[i].memberId });
    await act(i, "start", id);
    await act(i, "submit", id);
  };
  const verify = (id: string) =>
    act(0, "verify", id, { memberId: access.accounts[3].memberId });
  let main = "",
    rule = "",
    first = "",
    second = "";
  await check(
    "event creation, scope and payload-bound retries do not expose sibling or other-organization records",
    async () => {
      const input = {
        key: randomUUID(),
        title: "Synthetic event retry",
        unitId: region,
        startsAt: starts(),
        endsAt: ends(),
        contributionRuleId: null,
      };
      const [a, b] = await Promise.all([
        command(2, "event_create", input),
        command(2, "event_create", input),
      ]);
      assert.equal(a.id, b.id);
      main = a.id;
      await denied(
        command(2, "event_create", { ...input, title: "Different occurrence" }),
        409,
      );
      await denied(create(4));
      await denied(event(4, main));
      await denied(event(2, randomUUID()));
      assert.equal((await command(4, "event_list")).total, 0);
      assert.equal((await event(0, main)).canManage, true);
      await denied(
        command(2, "event_detail", { id: main, organizationId: randomUUID() }),
      );
      await denied(create(2, { endsAt: starts(), startsAt: ends() }), 400);
      await denied(create(2, { startsAt: "infinity" }), 400);
    },
  );
  await check(
    "approved event offer is pinned once, newer templates do not rewrite it or block linked tasks",
    async () => {
      const proposal = await collective(0, "propose", {
        key: randomUUID(),
        unitId: root,
        kind: "points_rule",
        parameters: {
          category: "task",
          ruleVersion: 0,
          amount: 17,
          enabled: true,
          memberMonthCap: 100000,
          issuerMonthCap: 100000,
        },
        reason: "Synthetic event reward",
        deadline: ends(),
      });
      await collective(1, "vote", {
        key: randomUUID(),
        id: proposal.id,
        version: (await collective(1, "detail", { id: proposal.id })).version,
        choice: "approve",
        reason: "Independent policy review",
      });
      rule = (await collective(0, "points")).rules.find(
        (r: any) => r.category === "task",
      ).id;
      main = (await create(2, { contributionRuleId: rule })).id;
      const newer = await collective(0, "propose", {
        key: randomUUID(),
        unitId: root,
        kind: "points_rule",
        parameters: {
          category: "task",
          ruleVersion: 1,
          amount: 29,
          enabled: true,
          memberMonthCap: 100000,
          issuerMonthCap: 100000,
        },
        reason: "Prospective event reward",
        deadline: ends(),
      });
      await collective(1, "vote", {
        key: randomUUID(),
        id: newer.id,
        version: (await collective(1, "detail", { id: newer.id })).version,
        choice: "approve",
        reason: "Independent policy review",
      });
      await denied(create(2, { contributionRuleId: rule }));
      const input = {
        key: randomUUID(),
        eventId: main,
        unitId: region,
        title: "Synthetic attendance",
        roleLabel: "Participant",
        priority: "normal",
        capacity: 4,
        deadline: ends(),
      };
      first = (await command(2, "create", input)).id;
      assert.equal((await command(2, "create", input)).id, first);
      second = (await task(main)).id;
      assert.equal((await detail(3, first)).contributionOffer.amount, 17);
      assert.equal((await detail(3, first)).event.id, main);
      await denied(task(main, 2, { contributionRuleId: null }), 400);
      await denied(task(main, 4, { unitId: sibling }));
      const other = (await create()).id;
      await denied(command(2, "create", { ...input, eventId: other }), 409);
    },
  );
  await check(
    "multiple confirmations create separate Activity but one event award under concurrent requests",
    async () => {
      await submit(first);
      await submit(second);
      const before = BigInt((await collective(3, "points")).balance);
      await Promise.all([verify(first), verify(second)]);
      assert.equal(
        BigInt((await collective(3, "points")).balance) - before,
        17n,
      );
      const rows = await owner.query(
        "SELECT count(*)::int AS n FROM event_participation_claims WHERE organization_id=$1 AND event_id=$2",
        [org, main],
      );
      assert.equal(rows.rows[0].n, 1);
      assert.equal((await detail(3, first)).assignments[0].status, "verified");
      assert.equal((await detail(3, second)).assignments[0].status, "verified");
      const activities = await owner.query(
        "SELECT count(*)::int AS n FROM activity_entries a JOIN work_assignments wa ON wa.organization_id=a.organization_id AND wa.id=a.assignment_id JOIN work_items w ON w.organization_id=wa.organization_id AND w.id=wa.work_id WHERE w.organization_id=$1 AND w.event_id=$2",
        [org, main],
      );
      assert.equal(activities.rows[0].n, 2);
      await denied(close(2, main), 409);
      await act(2, "complete", first);
      await act(2, "complete", second);
      await close(2, main);
      assert.equal((await event(2, main)).status, "completed");
      await denied(task(main), 409);
      assert.equal(
        BigInt((await collective(3, "points")).balance) - before,
        17n,
      );
    },
  );
  await check(
    "delegated tasks retain canonical event identity and expose only authorized tasks",
    async () => {
      const shared = (await create(0, { unitId: root })).id;
      const parent = (await task(shared, 0, { unitId: root, capacity: 8 })).id;
      const parentDeadline = new Date(
        (await detail(0, parent)).deadline,
      ).toISOString();
      const child = await act(0, "delegate", parent, {
        unitId: region,
        title: "Delegated event task",
        roleLabel: "Participant",
        priority: "normal",
        capacity: 2,
        deadline: parentDeadline,
      });
      const hidden = await act(0, "delegate", parent, {
        unitId: sibling,
        title: "Sibling private task",
        roleLabel: "Participant",
        priority: "normal",
        capacity: 2,
        deadline: parentDeadline,
      });
      assert.equal((await detail(2, child.id)).event.id, shared);
      const regional = await event(2, shared);
      assert.equal(regional.canManage, false);
      assert.deepEqual(
        regional.tasks.map((w: any) => w.id),
        [child.id],
      );
      assert.equal(JSON.stringify(regional).includes(hidden.id), false);
      await denied(task(shared));
      await denied(close(2, shared));
      assert.equal((await event(0, shared)).tasks.length, 3);
    },
  );
  await check(
    "audit failures roll back event, task link, occurrence claim and ledger together",
    async () => {
      const e = (
        await create(2, {
          contributionRuleId: (await collective(0, "points")).rules.find(
            (r: any) => r.category === "task",
          ).id,
        })
      ).id;
      const id = (await task(e)).id;
      await submit(id);
      const audit = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic audit outage");
      };
      try {
        await assert.rejects(verify(id), /Synthetic audit outage/);
        await assert.rejects(
          create(2, { title: "Synthetic rolled back event" }),
          /Synthetic audit outage/,
        );
        await assert.rejects(
          task(e, 2, { title: "Synthetic rolled back task" }),
          /Synthetic audit outage/,
        );
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
      }
      assert.equal((await detail(3, id)).assignments[0].status, "submitted");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM event_participation_claims WHERE organization_id=$1 AND event_id=$2",
            [org, e],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await command(2, "event_list", {
            search: "Synthetic rolled back event",
          })
        ).total,
        0,
      );
      assert.equal((await event(2, e)).tasks.length, 1);
      await verify(id);
    },
  );
  await check(
    "no-reward events keep Activity; closure retries preserve earned history and immutable claims",
    async () => {
      const e = (await create()).id,
        id = (await task(e)).id;
      const before = BigInt((await collective(3, "points")).balance);
      await submit(id);
      await verify(id);
      await act(2, "complete", id);
      assert.equal(BigInt((await collective(3, "points")).balance), before);
      const input = { id: e, key: randomUUID(), version: 1, note: "" };
      await command(2, "event_cancel", input);
      await command(2, "event_cancel", input);
      assert.equal((await event(2, e)).status, "cancelled");
      await assert.rejects(
        owner.query(
          "DELETE FROM event_participation_claims WHERE organization_id=$1 AND event_id=$2",
          [org, e],
        ),
      );
      await assert.rejects(
        owner.query(
          "UPDATE event_commands SET fingerprint=$1 WHERE organization_id=$2 AND event_id=$3",
          ["tampered", org, e],
        ),
      );
    },
  );
  await check(
    "moved hierarchy and revoked memberships deny event disclosure without changing history",
    async () => {
      const e = (await create()).id;
      const memberships = (
        await owner.query(
          "SELECT id FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, access.accounts[2].memberId],
        )
      ).rows.map((r: any) => r.id);
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
        [memberships],
      );
      try {
        await denied(event(2, e));
        await denied(task(e));
        assert.equal((await command(2, "event_list")).total, 0);
      } finally {
        await owner.query(
          "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
          [memberships],
        );
      }
      await owner.query(
        "UPDATE units SET parent_id=$1 WHERE organization_id=$2 AND id=$3",
        [sibling, org, region],
      );
      try {
        await denied(event(0, e));
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$1 WHERE organization_id=$2 AND id=$3",
          [root, org, region],
        );
      }
    },
  );
  await check(
    "corrections and exhausted caps never reopen the same event award",
    async () => {
      const latest = (await collective(0, "points")).rules.find(
        (r: any) => r.category === "task",
      );
      const e = (await create(2, { contributionRuleId: latest.id })).id;
      const a = (await task(e)).id,
        b = (await task(e)).id;
      await submit(a);
      await submit(b);
      await verify(a);
      const entry = (
        await owner.query(
          "SELECT ce.id FROM contribution_entries ce JOIN event_participation_claims ep ON ep.organization_id=ce.organization_id AND ep.activity_id=ce.source_id WHERE ep.organization_id=$1 AND ep.event_id=$2 AND ce.kind='award'",
          [org, e],
        )
      ).rows[0];
      const p = await collective(0, "propose", {
        key: randomUUID(),
        unitId: region,
        kind: "points_reverse",
        parameters: { entryId: entry.id },
        reason: "Synthetic correction",
        deadline: ends(),
      });
      await collective(2, "vote", {
        key: randomUUID(),
        id: p.id,
        version: (await collective(2, "detail", { id: p.id })).version,
        choice: "approve",
        reason: "Independent correction",
      });
      const balance = BigInt((await collective(3, "points")).balance);
      await verify(b);
      assert.equal(BigInt((await collective(3, "points")).balance), balance);
      const policy = await collective(0, "propose", {
        key: randomUUID(),
        unitId: root,
        kind: "points_rule",
        parameters: {
          category: "task",
          ruleVersion: 2,
          amount: 1,
          enabled: true,
          memberMonthCap: 1,
          issuerMonthCap: 1,
        },
        reason: "Synthetic cap boundary",
        deadline: ends(),
      });
      await collective(1, "vote", {
        key: randomUUID(),
        id: policy.id,
        version: (await collective(1, "detail", { id: policy.id })).version,
        choice: "approve",
        reason: "Independent cap policy",
      });
      const capped = (
        await create(2, {
          contributionRuleId: (await collective(0, "points")).rules.find(
            (r: any) => r.category === "task",
          ).id,
        })
      ).id;
      const c = (await task(capped)).id,
        d = (await task(capped)).id;
      await submit(c);
      await submit(d);
      await verify(c);
      await verify(d);
      assert.equal(BigInt((await collective(3, "points")).balance), balance);
      const entries = (
        await owner.query(
          "SELECT ce.kind FROM contribution_entries ce JOIN activity_entries ae ON ae.organization_id=ce.organization_id AND ae.id=ce.source_id JOIN work_assignments wa ON wa.organization_id=ae.organization_id AND wa.id=ae.assignment_id JOIN work_items w ON w.organization_id=wa.organization_id AND w.id=wa.work_id WHERE w.organization_id=$1 AND w.event_id=$2",
          [org, capped],
        )
      ).rows;
      assert.deepEqual(
        entries.map((r: any) => r.kind),
        ["cap_reached"],
      );
    },
  );
  await check(
    "authority expiring during audit rolls back event creation and its receipt",
    async () => {
      const grants = (
        await owner.query(
          "SELECT id,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, access.accounts[2].memberId],
        )
      ).rows;
      const audit = SecurityService.logAuditEventInTransaction;
      let reached = false;
      let expires: Date;
      SecurityService.logAuditEventInTransaction = async (client, ...rest) => {
        assert.equal(rest[1].operation, "event_create");
        assert.equal(rest[1].changed, true);
        reached = true;
        await audit.call(SecurityService, client, ...rest);
        while (
          !(
            await client.query(
              "SELECT clock_timestamp()>$1::timestamptz AS expired",
              [expires],
            )
          ).rows[0].expired
        )
          await client.query("SELECT pg_sleep(0.25)");
      };
      const key = randomUUID();
      try {
        const changed = await owner.query(
          "UPDATE memberships SET valid_until=clock_timestamp()+interval '10 seconds' WHERE id=ANY($1::uuid[]) RETURNING valid_until",
          [grants.map((g: any) => g.id)],
        );
        expires = new Date(
          Math.max(
            ...changed.rows.map((g: any) => new Date(g.valid_until).getTime()),
          ),
        );
        await denied(create(2, { key, title: "Synthetic expired creation" }));
      } finally {
        SecurityService.logAuditEventInTransaction = audit;
        for (const g of grants)
          await owner.query(
            "UPDATE memberships SET valid_until=$2 WHERE id=$1",
            [g.id, g.valid_until],
          );
      }
      assert.equal(reached, true);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM event_commands WHERE organization_id=$1 AND key=$2",
            [org, key],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await command(2, "event_list", {
            search: "Synthetic expired creation",
          })
        ).total,
        0,
      );
    },
  );
  await check(
    "HTTP events require session/CSRF and strict fields, with private responses",
    async () => {
      const path = "/api/v1/admin/work/event_create";
      await sessions[2].agent
        .post(path)
        .set("Origin", "http://localhost:15173")
        .send({})
        .expect(403);
      await sessions[2].agent
        .post(path)
        .set("Origin", "http://localhost:15173")
        .set("X-Admin-Csrf", sessions[2].csrf)
        .send({
          organizationId: org,
          key: randomUUID(),
          unitId: region,
          title: "Synthetic HTTP event",
          startsAt: starts(),
          endsAt: ends(),
          contributionRuleId: null,
          rewardPolicy: "stack",
        })
        .expect(400);
      await sessions[4].agent
        .get("/api/v1/admin/work/event_detail")
        .query({ organizationId: org, id: main })
        .expect(403);
      await sessions[2].agent
        .get("/api/v1/admin/work/event_detail")
        .query({ organizationId: org, id: main })
        .expect("Cache-Control", "no-store")
        .expect(200);
    },
  );
  await check(
    "event editing/rescheduling and explicit cascade-safe cancellation preserve history, claims and completed tasks",
    async () => {
      const editable = await create(2, { title: "Initial scheduled event" });
      const editKey = randomUUID();
      const nextStart = starts();
      const nextEnd = ends();
      const amended = await command(2, "event_edit", {
        key: editKey,
        id: editable.id,
        version: editable.version,
        title: "Rescheduled gathering",
        description: "Updated instructions",
        location: "Main hall",
        startsAt: nextStart,
        endsAt: nextEnd,
        note: "Adjusted date and hall",
      });
      assert.equal(amended.version, 2);
      const retrySame = await command(2, "event_edit", {
        key: editKey,
        id: editable.id,
        version: editable.version,
        title: "Rescheduled gathering",
        description: "Updated instructions",
        location: "Main hall",
        startsAt: nextStart,
        endsAt: nextEnd,
        note: "Adjusted date and hall",
      });
      assert.equal(retrySame.version, 2);
      await denied(
        command(2, "event_edit", {
          key: editKey,
          id: editable.id,
          version: editable.version,
          title: "Changed payload",
          description: "Updated instructions",
          location: "Main hall",
          startsAt: nextStart,
          endsAt: nextEnd,
          note: "Adjusted date and hall",
        }),
        409,
      );
      await denied(
        command(4, "event_edit", {
          key: randomUUID(),
          id: editable.id,
          version: 2,
          title: "Sibling edit denied",
          description: "",
          location: "",
          startsAt: nextStart,
          endsAt: nextEnd,
          note: "Cross-region attempt",
        }),
        403,
      );
      const openLinked = await command(2, "create", {
        key: randomUUID(),
        eventId: editable.id,
        unitId: region,
        title: "Open pending linked task",
        roleLabel: "Helper",
        priority: "normal",
        capacity: 3,
        deadline: nextEnd,
      });
      await denied(
        command(2, "event_cancel", {
          key: randomUUID(),
          id: editable.id,
          version: 2,
          note: "",
        }),
        409,
      );
      const cancelled = await command(2, "event_cancel", {
        key: randomUUID(),
        id: editable.id,
        version: 2,
        note: "Weather cancellation",
        cancelLinkedTasks: true,
      });
      assert.equal(cancelled.version, 3);
      const finalDetail = await event(2, editable.id);
      assert.equal(finalDetail.status, "cancelled");
      assert.equal(finalDetail.linkedSummary.cancelledTasks, 1);
      assert.equal(finalDetail.linkedSummary.openTasks, 0);
      assert.equal(finalDetail.history.length, 2);
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM work_items WHERE organization_id=$1 AND id=$2",
            [org, openLinked.id],
          )
        ).rows[0].status,
        "cancelled",
      );
    },
  );
}
