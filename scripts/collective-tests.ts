import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { testWorkOversight } from "./work-oversight-tests";
import type { collectiveCommand } from "../backend/src/modules/governance/collective";
import { SecurityService } from "../backend/src/services/security";

export async function testCollective(
  args: Parameters<typeof testWorkOversight>[0] & {
    collective: (
      i: number,
      op: Parameters<typeof collectiveCommand>[1],
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
    } = args,
    org = access.organizationId,
    unit = access.accounts[2].unitId;
  const deadline = () => new Date(Date.now() + 3600000).toISOString();
  const make = async () =>
    (
      await command(2, "create", {
        key: randomUUID(),
        unitId: unit,
        capacity: 3,
        title: "Synthetic funded task",
        description: "Synthetic external accounting",
        roleLabel: "Volunteer",
        priority: "normal",
        deadline: deadline(),
      })
    ).id;
  const propose = async (
    i: number,
    kind: string,
    workId: string | undefined,
    parameters: object,
    extra: object = {},
  ) =>
    c(i, "propose", {
      key: randomUUID(),
      unitId: workId ? (await detail(i, workId)).unitId : unit,
      kind,
      ...(workId ? { workId } : {}),
      parameters,
      reason: "Synthetic independent review",
      deadline: deadline(),
      ...extra,
    });
  const vote = async (i: number, id: string, choice = "approve") =>
    c(i, "vote", {
      id,
      key: randomUUID(),
      version: (await c(i, "detail", { id })).version,
      choice,
      reason: "Independent synthetic decision",
    });
  const approved = async (kind: string, workId: string, parameters: object) => {
    const p = await propose(2, kind, workId, parameters);
    await vote(3, p.id);
    return p.id;
  };
  const finance = (workId: string) => c(2, "funding", { workId });
  await check(
    "collective and financial authority require explicit grants",
    async () => {
      assert.deepEqual(await c(2, "contexts"), []);
    },
  );
  const { enableDemoCollective } = await import("./web-demo-collective");
  await owner.query("BEGIN");
  await enableDemoCollective(owner, access);
  await owner.query("COMMIT");
  await check(
    "independent collective approval, scoped notifications, rejection and immutable retry",
    async () => {
      const p = await propose(2, "directive", undefined, {
        title: "Synthetic operational directive",
        body: "Coordinate the synthetic volunteer meeting.",
      });
      await denied(vote(2, p.id));
      await denied(c(4, "detail", { id: p.id }));
      const inbox = await c(3, "list", { view: "inbox" });
      assert.ok(inbox.items.some((x: any) => x.id === p.id));
      const request = {
        id: p.id,
        key: randomUUID(),
        version: 1,
        choice: "approve",
        reason: "Independent agreement",
      };
      const result = await c(3, "vote", request);
      assert.deepEqual(await c(3, "vote", request), result);
      await denied(
        c(3, "vote", { ...request, reason: "Different payload" }),
        409,
      );
      assert.equal((await c(3, "detail", { id: p.id })).status, "approved");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM administrative_directives WHERE proposal_id=$1",
            [p.id],
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(
        owner.query("DELETE FROM collective_votes WHERE proposal_id=$1", [
          p.id,
        ]),
      );
      const reject = await propose(2, "directive", undefined, {
        title: "Synthetic rejected directive",
        body: "This must not be executed.",
      });
      await vote(3, reject.id, "reject");
      assert.equal(
        (await c(3, "detail", { id: reject.id })).status,
        "rejected",
      );
      await assert.rejects(
        owner.query(
          "UPDATE collective_proposals SET parameters='{}' WHERE id=$1",
          [p.id],
        ),
      );
      const expire = await propose(
        2,
        "directive",
        undefined,
        {
          title: "Synthetic expired directive",
          body: "This must not be executed.",
        },
        { deadline: new Date(Date.now() + 1500).toISOString() },
      );
      await new Promise((r) => setTimeout(r, 1600));
      await denied(vote(3, expire.id), 409);
    },
  );
  let work = "";
  await check(
    "partial pledged receipts, overpayment rejection and refunds retain exact remaining amounts",
    async () => {
      const w = await make();
      await approved("funding_target", w, {
        amount: "50000",
        currency: "GEL",
        purpose: "Synthetic pledged funds",
        targetVersion: 0,
      });
      const pledge = await c(3, "pledge", {
        workId: w,
        key: randomUUID(),
        amount: "20000",
      });
      const receipt = await approved("funding_receipt", w, {
        amount: "7500",
        externalRef: "SYN-PLEDGED-ONE",
        memberId: access.accounts[3].memberId,
        pledgeId: pledge.id,
      });
      let own = (await c(3, "funding", { workId: w })).pledges[0];
      assert.equal(own.fulfilled, "7500");
      assert.equal(own.remaining, "12500");
      await denied(
        approved("funding_receipt", w, {
          amount: "13000",
          externalRef: "SYN-PLEDGED-EXCESS",
          memberId: access.accounts[3].memberId,
          pledgeId: pledge.id,
        }),
        409,
      );
      await approved("funding_refund", w, {
        amount: "2500",
        referenceId: receipt,
        externalRef: "SYN-PLEDGED-REFUND",
      });
      own = (await c(3, "funding", { workId: w })).pledges[0];
      assert.equal(own.fulfilled, "5000");
      assert.equal(own.remaining, "15000");
    },
  );
  await check(
    "approved funding target; pledges and pending receipts never increase collected totals",
    async () => {
      work = await make();
      await approved("funding_target", work, {
        amount: "500000",
        currency: "GEL",
        purpose: "Synthetic community activity",
        targetVersion: 0,
      });
      await c(3, "pledge", {
        workId: work,
        key: randomUUID(),
        amount: "60000",
      });
      assert.equal((await finance(work)).target.totals.collected, "0");
      const p = await propose(2, "funding_receipt", work, {
        amount: "320000",
        externalRef: "SYN-RECEIPT-ONE",
        memberId: access.accounts[2].memberId,
      });
      assert.equal((await finance(work)).target.totals.collected, "0");
      await denied(vote(2, p.id));
      await vote(3, p.id);
      assert.equal((await finance(work)).target.totals.collected, "320000");
      await denied(
        approved("funding_receipt", work, {
          amount: "320000",
          externalRef: "SYN-RECEIPT-ONE",
          memberId: access.accounts[2].memberId,
        }),
        409,
      );
      await denied(
        propose(2, "funding_receipt", work, {
          amount: "0.5",
          externalRef: "INVALID-FRACTION",
          memberId: access.accounts[2].memberId,
        }),
        400,
      );
      await denied(c(4, "funding", { workId: work }));
    },
  );
  await check(
    "expenses, reservations, conversion, refunds and corrections use exact minor units",
    async () => {
      const expense = await approved("funding_expense", work, {
        amount: "110000",
        externalRef: "SYN-EXPENSE-ONE",
      });
      const reservation = await approved("funding_reserve", work, {
        amount: "50000",
      });
      let t = (await finance(work)).target.totals;
      assert.equal(t.available, "160000");
      assert.equal(t.spent, "110000");
      assert.equal(t.committed, "50000");
      assert.equal(t.stillNeeded, "180000");
      await approved("funding_expense", work, {
        amount: "20000",
        referenceId: reservation,
        externalRef: "SYN-RESERVED-EXPENSE",
      });
      t = (await finance(work)).target.totals;
      assert.equal(t.available, "160000");
      assert.equal(t.committed, "30000");
      assert.equal(t.spent, "130000");
      await approved("funding_release", work, {
        amount: "30000",
        referenceId: reservation,
      });
      assert.equal((await finance(work)).target.totals.available, "190000");
      await denied(
        approved("funding_release", work, {
          amount: "1",
          referenceId: reservation,
        }),
        409,
      );
      await approved("funding_reverse", work, {
        amount: "10000",
        referenceId: expense,
      });
      assert.equal((await finance(work)).target.totals.spent, "120000");
      const receipt = (await finance(work)).entries.find(
        (e: any) => e.kind === "receipt",
      ).id;
      await approved("funding_refund", work, {
        amount: "10000",
        referenceId: receipt,
        externalRef: "SYN-REFUND-ONE",
      });
      assert.equal((await finance(work)).target.totals.collected, "310000");
      await denied(
        approved("funding_target", work, {
          amount: "500000",
          currency: "USD",
          purpose: "No silent exchange",
          targetVersion: 1,
        }),
        409,
      );
    },
  );
  await check(
    "concurrent expense approval cannot spend the same available money twice",
    async () => {
      const p = await propose(2, "funding_expense", work, {
          amount: "150000",
          externalRef: "SYN-RACE-ONE",
        }),
        q = await propose(2, "funding_expense", work, {
          amount: "150000",
          externalRef: "SYN-RACE-TWO",
        });
      const results = await Promise.allSettled([vote(3, p.id), vote(3, q.id)]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal((await finance(work)).target.totals.available, "40000");
    },
  );
  await check(
    "collective execution and financial entries roll back on audit failure",
    async () => {
      const p = await propose(2, "funding_receipt", work, {
        amount: "100",
        externalRef: "SYN-AUDIT-FAILURE",
        memberId: access.accounts[2].memberId,
      });
      const original = SecurityService.logAuditEventInTransaction;
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw new Error("Synthetic collective audit failure");
        };
        await assert.rejects(
          c(3, "vote", {
            id: p.id,
            key: randomUUID(),
            version: 1,
            choice: "approve",
            reason: "Review",
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal((await c(3, "detail", { id: p.id })).status, "pending");
      assert.equal((await c(3, "detail", { id: p.id })).votes.length, 0);
      assert.equal((await finance(work)).target.totals.available, "40000");
    },
  );
  await check(
    "member financial projection suppresses small cohorts and hides donor records",
    async () => {
      const rows = (
        await owner.query(
          "SELECT m.id FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.organization_id=$1 AND m.user_id=$2 AND p.name='Collective finance demo'",
          [org, access.accounts[3].memberId],
        )
      ).rows;
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
        [rows.map((r) => r.id)],
      );
      try {
        const view = await c(3, "funding", { workId: work });
        assert.equal(view.target.suppressed, true);
        assert.equal(view.target.totals, null);
        assert.deepEqual(view.entries, []);
        assert.equal(view.pledges.length, 1);
      } finally {
        await owner.query(
          "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
          [rows.map((r) => r.id)],
        );
      }
      await denied(approved("funding_publish", work, {}), 409);
    },
  );
  await check(
    "publication requires ten net contributors and blocks rapid differencing",
    async () => {
      const w = await make();
      await approved("funding_target", w, {
        amount: "50000",
        currency: "GEL",
        purpose: "Synthetic protected public summary",
        targetVersion: 0,
      });
      const position = (
        await owner.query(
          "SELECT id FROM positions WHERE organization_id=$1 AND unit_id=$2 AND name='Work demo'",
          [org, unit],
        )
      ).rows[0].id;
      const donors: string[] = [];
      for (let n = 0; n < 10; n++) {
        const donor = randomUUID();
        donors.push(donor);
        await owner.query("INSERT INTO member_users(id) VALUES($1)", [donor]);
        await owner.query(
          "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
          [org, donor, unit, position],
        );
        await approved("funding_receipt", w, {
          amount: "1000",
          externalRef: "SYN-COHORT-" + n,
          memberId: donor,
        });
      }
      await approved("funding_publish", w, {});
      const snapshot = (
        await owner.query(
          "SELECT member_snapshot FROM work_funding_targets WHERE organization_id=$1 AND work_id=$2",
          [org, w],
        )
      ).rows[0].member_snapshot;
      assert.equal(snapshot.collected, "10000");
      assert.equal(snapshot.available, "10000");
      assert.equal(
        donors.some((id) => JSON.stringify(snapshot).includes(id)),
        false,
      );
      await denied(approved("funding_publish", w, {}), 409);
      const original = SecurityService.logAuditEventInTransaction;
      const proposal = await propose(2, "funding_expense", w, {
        amount: "100",
        externalRef: "SYN-EXPIRED-AUTHORITY",
      });
      const authority=(await owner.query("SELECT m.id,m.valid_until FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.user_id=$1 AND p.name='Collective finance demo'",[access.accounts[3].memberId])).rows[0];
      await owner.query("UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=$1",[authority.id]);
      try {
        SecurityService.logAuditEventInTransaction = async (
          client,
          ...args
        ) => {
          await original.call(SecurityService, client, ...args);
          await client.query('SELECT pg_sleep(3)');
        };
        await denied(
          c(3, "vote", {
            id: proposal.id,
            key: randomUUID(),
            version: 1,
            choice: "approve",
            reason: "Expiry during required audit",
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        await owner.query('UPDATE memberships SET valid_until=$2 WHERE id=$1',[authority.id,authority.valid_until]);
      }
      assert.equal(
        (await c(3, "detail", { id: proposal.id })).status,
        "pending",
      );
      assert.equal((await finance(w)).target.totals.spent, "0");
    },
  );
  await check(
    "child envelopes reserve existing funds without inventing revenue",
    async () => {
      const parent = await make();
      const group = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 AND kind='authority' ORDER BY id LIMIT 1",
          [org, unit],
        )
      ).rows[0].id;
      const child = (
        await act(2, "delegate", parent, {
          unitId: group,
          title: "Synthetic child funding",
          description: "Child budget",
          roleLabel: "Volunteer",
          capacity: 1,
          priority: "normal",
          deadline: new Date((await detail(2, parent)).deadline).toISOString(),
        })
      ).id;
      await act(2, "accept", child, { capacity: 1 });
      await approved("funding_target", parent, {
        amount: "10000",
        currency: "GEL",
        purpose: "Synthetic parent budget",
        targetVersion: 0,
      });
      await approved("funding_receipt", parent, {
        amount: "10000",
        externalRef: "SYN-PARENT-RECEIPT",
        memberId: access.accounts[2].memberId,
      });
      await approved("funding_envelope", parent, {
        amount: "7000",
        childId: child,
      });
      assert.equal((await finance(parent)).target.totals.collected, "10000");
      assert.equal((await finance(parent)).target.totals.available, "3000");
      assert.equal((await finance(child)).target.totals.collected, null);
      assert.equal((await finance(child)).target.totals.allocated, "7000");
      await denied(
        approved("funding_expense", parent, {
          amount: "4000",
          externalRef: "SYN-OVER-ENVELOPE",
        }),
        409,
      );
    },
  );
  await check(
    "majority policy freezes eligible independent reviewers and requires actual quorum",
    async () => {
      const pos = (
        await owner.query(
          "SELECT id FROM positions WHERE organization_id=$1 AND unit_id=$2 AND name='Collective finance demo'",
          [org, unit],
        )
      ).rows[0].id;
      const inserted: string[] = [];
      try {
        for (const index of [0, 1])
          inserted.push(
            (
              await owner.query(
                "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day') RETURNING id",
                [org, access.accounts[index].memberId, unit, pos],
              )
            ).rows[0].id,
          );
        const policy = await propose(2, "policy", undefined, {
          policyVersion: 0,
          method: "majority",
          minimum: 1,
        });
        await vote(3, policy.id);
        const p = await propose(2, "directive", undefined, {
          title: "Synthetic majority decision",
          body: "Two independent reviewers must agree.",
        });
        assert.equal((await c(3, "detail", { id: p.id })).threshold, 2);
        await vote(3, p.id);
        assert.equal((await c(3, "detail", { id: p.id })).status, "pending");
        await vote(0, p.id);
        assert.equal((await c(3, "detail", { id: p.id })).status, "approved");
      } finally {
        await owner.query(
          "UPDATE memberships SET status='suspended' WHERE id=ANY($1::uuid[])",
          [inserted],
        );
      }
    },
  );
}
