import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SecurityService } from "../backend/src/services/security";

export async function testWorkRecognition({
  command,
  collective: c,
  act,
  owner,
  access,
  check,
  denied,
  sessions,
}: any) {
  const org = access.organizationId,
    root = access.accounts[0].unitId,
    unit = access.accounts[2].unitId,
    member = access.accounts[3].memberId;
  const deadline = () => new Date(Date.now() + 3600000).toISOString();
  const propose = (kind: string, parameters: object, unitId = unit) =>
    c(0, "propose", {
      key: randomUUID(),
      unitId,
      kind,
      parameters,
      reason: "Synthetic contextual recognition",
      deadline: deadline(),
    });
  const vote = async (i: number, id: string) =>
    c(i, "vote", {
      id,
      key: randomUUID(),
      version: (await c(i, "detail", { id })).version,
      choice: "approve",
      reason: "Independent recognition review",
    });
  const make = async () => {
    const { id } = await command(2, "create", {
      key: randomUUID(),
      unitId: unit,
      title: "Synthetic verified contribution",
      roleLabel: "Volunteer",
      priority: "normal",
      capacity: 3,
      deadline: deadline(),
      contributionRuleId: null,
    });
    await act(3, "apply", id);
    await act(2, "assign", id, { memberId: member });
    await act(3, "start", id);
    await act(3, "submit", id);
    return id;
  };
  let work = "",
    activity = "",
    rule = "",
    proposal = "";
  const params = () => ({
    memberId: member,
    activityId: activity,
    ruleId: rule,
    amount: 5,
  });
  await check(
    "recognition requires an enabled policy and verified scoped participation; reads expose neither self nor siblings",
    async () => {
      work = await make();
      assert.deepEqual(
        (await c(0, "recognition", { workId: work })).participants,
        [],
      );
      await act(0, "verify", work, { memberId: member });
      assert.equal(
        (await c(0, "recognition", { workId: work })).canAward,
        false,
      );
      const policy = await propose(
        "points_rule",
        {
          category: "manual",
          ruleVersion: 0,
          enabled: true,
          amount: 20,
          memberMonthCap: 200,
          issuerMonthCap: 200,
        },
        root,
      );
      await vote(1, policy.id);
      const context = await c(0, "recognition", { workId: work });
      assert.equal(context.canAward, true);
      assert.equal(context.participants.length, 1);
      activity = context.participants[0].activityId;
      rule = context.rule.id;
      assert.equal(context.participants[0].memberId, member);
      assert.deepEqual(
        (await c(3, "recognition", { workId: work })).participants,
        [],
      );
      await denied(c(4, "recognition", { workId: work }));
      await denied(c(0, "recognition", { workId: randomUUID() }));
      await denied(
        c(0, "recognition", { organizationId: randomUUID(), workId: work }),
      );
    },
  );
  await check(
    "linked recognition rejects forged source, mismatched member/unit, self, sibling and excessive amount",
    async () => {
      await denied(
        propose("points_award", { ...params(), activityId: randomUUID() }),
      );
      await denied(
        propose("points_award", {
          ...params(),
          memberId: access.accounts[2].memberId,
        }),
      );
      await denied(propose("points_award", params(), root));
      await denied(
        c(3, "propose", {
          key: randomUUID(),
          unitId: unit,
          kind: "points_award",
          parameters: params(),
          reason: "Self award attempt",
          deadline: deadline(),
        }),
      );
      await denied(
        c(4, "propose", {
          key: randomUUID(),
          unitId: unit,
          kind: "points_award",
          parameters: params(),
          reason: "Sibling award attempt",
          deadline: deadline(),
        }),
      );
      await denied(propose("points_award", { ...params(), amount: 21 }), 400);
    },
  );
  await check(
    "exact concurrent retries have one proposal; separate concurrent and differently cased source duplicates conflict",
    async () => {
      const input = {
        key: randomUUID(),
        unitId: unit,
        kind: "points_award",
        parameters: params(),
        reason: "Synthetic extra contribution",
        deadline: deadline(),
      };
      const [a, b] = await Promise.all([
        c(0, "propose", input),
        c(0, "propose", input),
      ]);
      assert.equal(a.id, b.id);
      proposal = a.id;
      await denied(
        c(0, "propose", {
          ...input,
          key: randomUUID(),
          parameters: { ...params(), activityId: activity.toUpperCase() },
        }),
        409,
      );
      await denied(c(0, "propose", { ...input, key: randomUUID() }), 409);
      assert.equal(
        (await c(0, "recognition", { workId: work })).participants[0].state,
        "pending",
      );
      assert.equal(
        (await c(0, "detail", { id: proposal })).recognitionSource.workTitle,
        "Synthetic verified contribution",
      );
      assert.equal((await c(3, "detail", { id: proposal })).canVote, false);
      await denied(vote(0, proposal));
      await denied(vote(3, proposal));
    },
  );
  await check(
    "audit failure rolls back approval and points; approval creates one linked private history entry",
    async () => {
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async function (
        ...args: any[]
      ) {
        if (args[1] === "COLLECTIVE_COMMAND" && args[2]?.operation === "vote")
          throw new Error("Synthetic audit failure");
        return (original as any).apply(this, args);
      } as any;
      try {
        await assert.rejects(vote(2, proposal));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal((await c(0, "detail", { id: proposal })).status, "pending");
      await vote(2, proposal);
      assert.equal(
        (await c(0, "recognition", { workId: work })).participants[0].state,
        "awarded",
      );
      const points = await c(3, "points");
      const linked = points.entries.filter((e: any) => e.recognitionSource);
      assert.equal(linked.length, 1);
      assert.equal(linked[0].points, 5);
      assert.equal(
        linked[0].recognitionSource.workTitle,
        "Synthetic verified contribution",
      );
      await denied(c(4, "points", { memberId: member, unitId: unit }));
      await denied(propose("points_award", params()), 409);
      const reversal = await propose("points_reverse", {
        entryId: linked[0].id,
      });
      await vote(2, reversal.id);
      const corrected = await c(3, "points");
      assert.equal(
        corrected.entries.filter((e: any) => e.recognitionSource).length,
        2,
      );
      await denied(propose("points_award", params()), 409);
    },
  );
  await check(
    "withdrawal frees the source; a changed rule blocks stale approval without minting points",
    async () => {
      const next = await make();
      await act(0, "verify", next, { memberId: member });
      activity = (await c(0, "recognition", { workId: next })).participants[0]
        .activityId;
      const race = await Promise.allSettled([
        propose("points_award", params()),
        propose("points_award", params()),
      ]);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      const loser = race.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult;
      assert.equal(loser.reason.statusCode, 409);
      const first = (
        race.find(
          (r) => r.status === "fulfilled",
        ) as PromiseFulfilledResult<any>
      ).value;
      await c(0, "withdraw", {
        id: first.id,
        key: randomUUID(),
        version: (await c(0, "detail", { id: first.id })).version,
      });
      const pending = await propose("points_award", params());
      const policy = await propose(
        "points_rule",
        {
          category: "manual",
          ruleVersion: 1,
          enabled: true,
          amount: 10,
          memberMonthCap: 200,
          issuerMonthCap: 200,
        },
        root,
      );
      await vote(1, policy.id);
      await denied(vote(2, pending.id), 409);
      assert.equal(
        (await c(0, "detail", { id: pending.id })).status,
        "pending",
      );
    },
  );
  await check(
    "task titles disappear from private recognition history when Work access expires",
    async () => {
      const grants = (
        await owner.query(
          "SELECT m.id,m.valid_until FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.organization_id=$1 AND m.user_id=$2 AND p.name='Work demo'",
          [org, member],
        )
      ).rows;
      assert.ok(grants.length);
      try {
        await owner.query(
          "UPDATE memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",
          [grants.map((g: any) => g.id)],
        );
        const history = await c(3, "points");
        assert.ok(history.entries.some((e: any) => e.recognitionSource));
        for (const entry of history.entries.filter(
          (e: any) => e.recognitionSource,
        ))
          assert.equal(entry.recognitionSource.workTitle, null);
        await denied(c(3, "recognition", { workId: work }));
      } finally {
        for (const grant of grants)
          await owner.query(
            "UPDATE memberships SET valid_until=$2 WHERE id=$1",
            [grant.id, grant.valid_until],
          );
      }
    },
  );
  await check(
    "authority expiry during audit hides recipient lists and rolls back bonus proposals",
    async () => {
      const next = await make();
      await act(0, "verify", next, { memberId: member });
      const context = await c(0, "recognition", { workId: next });
      const grants = (
        await owner.query(
          "SELECT id,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, access.accounts[0].memberId],
        )
      ).rows;
      for (const operation of ["recognition", "propose"]) {
        let reached = false;
        let expiresAt: Date;
        const original = SecurityService.logAuditEventInTransaction;
        SecurityService.logAuditEventInTransaction = async (
          client,
          ...rest
        ) => {
          assert.equal(rest[0], "COLLECTIVE_COMMAND");
          assert.equal(rest[1].operation, operation);
          reached = true;
          await original.call(SecurityService, client, ...rest);
          await client.query(
            "SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.1)",
            [expiresAt],
          );
        };
        try {
          const changed = await owner.query(
            "UPDATE memberships SET valid_until=clock_timestamp()+interval '8 seconds' WHERE id=ANY($1::uuid[]) RETURNING valid_until",
            [grants.map((g: any) => g.id)],
          );
          expiresAt = new Date(
            Math.max(
              ...changed.rows.map((g: any) =>
                new Date(g.valid_until).getTime(),
              ),
            ),
          );
          await denied(
            operation === "recognition"
              ? c(0, "recognition", { workId: next })
              : propose("points_award", {
                  memberId: member,
                  activityId: context.participants[0].activityId,
                  ruleId: context.rule.id,
                  amount: 5,
                }),
          );
        } finally {
          SecurityService.logAuditEventInTransaction = original;
          for (const grant of grants)
            await owner.query(
              "UPDATE memberships SET valid_until=$2 WHERE id=$1",
              [grant.id, grant.valid_until],
            );
        }
        assert.equal(reached, true);
        assert.equal(
          (await c(0, "recognition", { workId: next })).participants[0].state,
          "available",
        );
      }
    },
  );
  await check(
    "HTTP recognition is no-store and rejects foreign scope, unknown fields and non-CSRF writes",
    async () => {
      const base = "/api/v1/admin/collective";
      await sessions[0].agent
        .get(base + "/recognition")
        .query({ organizationId: org, workId: work })
        .expect("Cache-Control", "no-store")
        .expect(200);
      await sessions[4].agent
        .get(base + "/recognition")
        .query({ organizationId: org, workId: work })
        .expect(403);
      await sessions[0].agent
        .get(base + "/recognition")
        .query({ organizationId: org, workId: work, memberId: member })
        .expect(400);
      await sessions[0].agent
        .post(base + "/propose")
        .set("Origin", "http://localhost:15173")
        .send({})
        .expect(403);
      const result = await owner.query(
        "SELECT count(*)::integer AS count FROM ertad.contribution_entries WHERE organization_id=$1 AND category=$2",
        [org, "manual"],
      );
      assert.equal(result.rows[0].count, 2);
    },
  );
}
