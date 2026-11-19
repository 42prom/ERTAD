import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { testCollective } from "./collective-tests";
import type { decisionCommand } from "../backend/src/modules/decisions/polls";
import { SecurityService } from "../backend/src/services/security";
export async function testContribution(
  args: Parameters<typeof testCollective>[0] & {
    decision: (
      i: number,
      op: Parameters<typeof decisionCommand>[1],
      input?: object,
    ) => Promise<any>;
  },
) {
  const {
      command,
      act,
      detail,
      owner,
      access,
      check,
      denied,
      collective: c,
      decision,
    } = args,
    org = access.organizationId,
    root = access.accounts[0].unitId,
    unit = access.accounts[2].unitId;
  const deadline = () => new Date(Date.now() + 3600000).toISOString();
  const propose = async (
    i: number,
    kind: string,
    unitId: string,
    parameters: object,
  ) =>
    c(i, "propose", {
      key: randomUUID(),
      unitId,
      kind,
      parameters,
      reason: "Synthetic contribution policy review",
      deadline: deadline(),
    });
  const vote = async (i: number, id: string) =>
    c(i, "vote", {
      id,
      key: randomUUID(),
      version: (await c(i, "detail", { id })).version,
      choice: "approve",
      reason: "Independent contribution review",
    });
  const rules = async () => (await c(0, "points")).rules;
  const rule = async (category: string, amount: number, cap = 1000) => {
    const old = (await rules()).find((r: any) => r.category === category);
    const p = await propose(0, "points_rule", root, {
      category,
      ruleVersion: old?.version ?? 0,
      enabled: true,
      amount,
      memberMonthCap: cap,
      issuerMonthCap: 1000,
    });
    await vote(1, p.id);
    return (await rules()).find((r: any) => r.category === category);
  };
  const make = async () =>
    (
      await command(2, "create", {
        key: randomUUID(),
        unitId: unit,
        capacity: 1,
        title: "Synthetic recognized activity",
        description: "Verified participation only",
        roleLabel: "Volunteer",
        priority: "normal",
        deadline: deadline(),
      })
    ).id;
  const complete = async (id: string) => {
    await act(3, "apply", id);
    await act(2, "assign", id, { memberId: access.accounts[3].memberId });
    await act(3, "start", id);
    await act(3, "submit", id);
    return act(0, "verify", id, { memberId: access.accounts[3].memberId });
  };
  const { enableDemoContribution } = await import("./web-demo-contribution");
  await owner.query("BEGIN");
  await enableDemoContribution(owner, access);
  await owner.query("COMMIT");
  await check(
    "reward rules require root scope and independent approval; task rules are prospective",
    async () => {
      const before = await make();
      await rule("task", 10);
      const pinned = await make();
      await rule("task", 20);
      await denied(
        propose(2, "points_rule", unit, {
          category: "task",
          ruleVersion: 2,
          enabled: true,
          amount: 999,
          memberMonthCap: 1000,
          issuerMonthCap: 1000,
        }),
      );
      await complete(before);
      assert.equal((await c(3, "points")).balance, "0");
      await complete(pinned);
      assert.equal((await c(3, "points")).balance, "10");
      assert.equal((await detail(3, pinned)).contributionOffer.amount, 10);
      const current = await make();
      await complete(current);
      assert.equal((await c(3, "points")).balance, "30");
      const source = (
        await owner.query(
          "SELECT id FROM activity_entries WHERE assignment_id IN(SELECT id FROM work_assignments WHERE work_id=$1)",
          [current],
        )
      ).rows[0].id;
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM contribution_entries WHERE source_id=$1",
            [source],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    "monthly caps never block participation or manufacture extra points",
    async () => {
      await rule("task", 20, 40);
      const id = await make();
      await complete(id);
      const view = await c(3, "points");
      assert.equal(view.balance, "30");
      assert.ok(
        view.entries.some(
          (e: any) => e.kind === "cap_reached" && e.points === 0,
        ),
      );
    },
  );
  await check(
    "scoped manual recognition, no self-award or beneficiary approval, linked reversal and private history",
    async () => {
      const manual = await rule("manual", 25);
      await denied(
        propose(0, "points_award", root, {
          memberId: access.accounts[0].memberId,
          ruleId: manual.id,
          amount: 20,
        }),
      );
      const p = await propose(0, "points_award", unit, {
        memberId: access.accounts[3].memberId,
        ruleId: manual.id,
        amount: 20,
      });
      await denied(vote(3, p.id));
      await vote(2, p.id);
      const own = await c(3, "points");
      assert.equal(own.balance, "50");
      const entry = own.entries.find(
        (e: any) => e.category === "manual" && e.kind === "award",
      );
      await denied(
        c(4, "points", { unitId: unit, memberId: access.accounts[3].memberId }),
      );
      const reverse = await propose(0, "points_reverse", unit, {
        entryId: entry.id,
      });
      await vote(2, reverse.id);
      assert.equal((await c(3, "points")).balance, "30");
      const again = await propose(0, "points_reverse", unit, {
        entryId: entry.id,
      });
      await denied(vote(2, again.id), 409);
      await assert.rejects(
        owner.query("UPDATE contribution_entries SET points=999 WHERE id=$1", [
          entry.id,
        ]),
      );
    },
  );
  await check(
    "automatic participation and its recognition roll back together when audit fails",
    async () => {
      await rule("task", 5);
      const id = await make();
      await act(3, "apply", id);
      await act(2, "assign", id, { memberId: access.accounts[3].memberId });
      await act(3, "start", id);
      await act(3, "submit", id);
      const d = await detail(2, id),
        before = (await c(3, "points")).balance,
        original = SecurityService.logAuditEventInTransaction;
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw new Error("Synthetic points audit failure");
        };
        await assert.rejects(
          command(0, "verify", {
            id,
            version: d.version,
            key: randomUUID(),
            memberId: access.accounts[3].memberId,
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal((await c(3, "points")).balance, before);
      assert.equal((await detail(2, id)).assignments[0].status, "submitted");
    },
  );
  await check(
    "named voting and survey rewards follow participation only and cancel through compensating entries",
    async () => {
      const { enableDemoDecisions } = await import("./web-demo-decisions");
      await owner.query("BEGIN");
      await enableDemoDecisions(owner, access);
      await owner.query("COMMIT");
      await rule("vote", 3);
      await rule("survey", 7);
      const base = {
        key: randomUUID(),
        unitId: unit,
        title: "Synthetic rewarded participation",
        description: "Named participation only",
        quorum: 1,
        closesAt: deadline(),
      };
      const poll = (
        await decision(2, "create", {
          ...base,
          kind: "poll",
          options: ["One", "Two"],
        })
      ).id;
      await decision(2, "publish", { id: poll, key: randomUUID(), version: 1 });
      const before = BigInt((await c(3, "points")).balance),
        v = { id: poll, key: randomUUID(), choice: 1 };
      await decision(3, "vote", v);
      await decision(3, "vote", v);
      assert.equal(BigInt((await c(3, "points")).balance), before + 3n);
      const qid = randomUUID(),
        survey = (
          await decision(2, "create", {
            ...base,
            key: randomUUID(),
            kind: "survey",
            options: [],
            questions: [
              {
                id: qid,
                type: "text",
                title: "Synthetic question",
                required: true,
                maxLength: 100,
              },
            ],
          })
        ).id;
      await decision(2, "publish", {
        id: survey,
        key: randomUUID(),
        version: 1,
      });
      await decision(3, "vote", {
        id: survey,
        key: randomUUID(),
        answers: { [qid]: "Synthetic answer" },
      });
      assert.equal(BigInt((await c(3, "points")).balance), before + 10n);
      const current = await decision(2, "detail", { id: poll });
      assert.equal(current.contributionOffer.amount, 3);
      await decision(2, "cancel", {
        id: poll,
        key: randomUUID(),
        version: current.version,
      });
      assert.equal(BigInt((await c(3, "points")).balance), before + 7n);
      const stored = (
        await owner.query(
          "SELECT to_jsonb(e) data FROM contribution_entries e WHERE organization_id=$1 AND source_kind='decision_participation'",
          [org],
        )
      ).rows;
      for (const r of stored) {
        assert.equal("choice" in r.data, false);
        assert.equal("answers" in r.data, false);
        assert.equal("created_at" in r.data, false);
      }
      const ledger = (
        await owner.query(
          "SELECT id,kind,category,source_id,earned_on FROM contribution_entries WHERE organization_id=$1 AND user_id=$2",
          [org, access.accounts[3].memberId],
        )
      ).rows;
      const notices = (
        await owner.query(
          "SELECT * FROM ertad.inbox_entries($1,$2) WHERE source='contribution'",
          [access.accounts[3].memberId, org],
        )
      ).rows;
      assert.deepEqual(
        new Set(notices.map((n) => n.id)),
        new Set(ledger.map((e) => e.id)),
      );
      for (const category of ["task", "vote", "survey", "manual"])
        assert.ok(ledger.some((e) => e.category === category));
      for (const kind of ["award", "reversal", "cap_reached"])
        assert.ok(notices.some((n) => n.status === kind));
      for (const notice of notices) {
        assert.equal(notice.title, "contribution_record");
        assert.equal(notice.action, "");
        assert.match(
          new Date(notice.updated_at).toISOString(),
          /T00:00:00\.000Z$/,
        );
        const serialized = JSON.stringify(notice);
        for (const entry of ledger)
          assert.equal(serialized.includes(entry.source_id), false);
        assert.equal(serialized.includes("Synthetic answer"), false);
      }
    },
  );
}
