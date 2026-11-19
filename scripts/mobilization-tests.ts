import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { testCollective } from "./collective-tests";
import { SecurityService } from "../backend/src/services/security";

export async function testMobilization(
  args: Parameters<typeof testCollective>[0],
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
  } = args;
  const org = access.organizationId,
    root = access.accounts[0].unitId,
    region = access.accounts[2].unitId,
    sibling = access.accounts[4].unitId;
  const deadline = () => new Date(Date.now() + 3600000).toISOString();
  const rules = async () => (await c(0, "points")).rules;
  const propose = async (i: number, input: object) =>
    c(i, "propose", {
      key: randomUUID(),
      unitId: root,
      kind: "points_rule",
      parameters: input,
      reason: "Synthetic mobilization policy",
      deadline: deadline(),
    });
  const vote = async (i: number, id: string) =>
    c(i, "vote", {
      id,
      key: randomUUID(),
      version: (await c(i, "detail", { id })).version,
      choice: "approve",
      reason: "Independent template review",
    });
  const parameters = (
    id: string,
    version = 0,
    amount = 30,
    enabled = true,
  ) => ({
    category: "task",
    templateId: id,
    title: "Synthetic driving support",
    allowedUnitId: region,
    ruleVersion: version,
    amount,
    enabled,
    memberMonthCap: 100000,
    issuerMonthCap: 100000,
  });
  const create = (rule: string | null, extra: object = {}) =>
    command(2, "create", {
      key: randomUUID(),
      unitId: region,
      title: "Synthetic mobilization",
      description: "Voluntary practical support",
      roleLabel: "Driver",
      priority: "normal",
      capacity: 2,
      deadline: deadline(),
      contributionRuleId: rule,
      location: "Synthetic meeting place",
      startsAt: new Date(Date.now() + 60000).toISOString(),
      ...extra,
    });
  const complete = async (id: string) => {
    await act(3, "apply", id);
    await act(2, "assign", id, { memberId: access.accounts[3].memberId });
    await act(3, "start", id);
    await act(3, "submit", id);
    await denied(
      act(3, "verify", id, { memberId: access.accounts[3].memberId }),
      409,
    );
    await act(0, "verify", id, { memberId: access.accounts[3].memberId });
  };
  const template = randomUUID();
  let first: any,
    task = "";
  await check(
    "reward templates require independent root policy approval and expose only allowed scope",
    async () => {
      await denied(propose(2, parameters(template)));
      const p = await propose(0, parameters(template));
      await denied(vote(0, p.id));
      assert.equal(
        (await rules()).some((r: any) => r.templateId === template),
        false,
      );
      await vote(1, p.id);
      first = (await rules()).find((r: any) => r.templateId === template);
      assert.equal(first.amount, 30);
      const units = await command(2, "units");
      assert.ok(
        units
          .find((u: any) => u.id === region)
          .rewardOptions.some((r: any) => r.id === first.id),
      );
      assert.equal(
        (await command(4, "units"))
          .flatMap((u: any) => u.rewardOptions)
          .some((r: any) => r.id === first.id),
        false,
      );
      await denied(
        command(4, "create", {
          key: randomUUID(),
          unitId: sibling,
          title: "Forged regional offer",
          roleLabel: "Participant",
          capacity: 1,
          priority: "normal",
          deadline: deadline(),
          contributionRuleId: first.id,
        }),
      );
      task = (await create(first.id)).id;
      assert.equal(
        (await detail(3, task)).contributionOffer.title,
        "Synthetic driving support",
      );
      assert.equal((await detail(3, task)).location, "Synthetic meeting place");
    },
  );
  await check(
    "template edits are prospective; an explicit no-reward task creates Activity without points",
    async () => {
      const p = await propose(0, parameters(template, 1, 45));
      await vote(1, p.id);
      const current = (await rules()).find(
        (r: any) => r.templateId === template,
      );
      await denied(create(first.id));
      assert.equal((await detail(3, task)).contributionOffer.amount, 30);
      const before = BigInt((await c(3, "points")).balance);
      await complete(task);
      assert.equal(BigInt((await c(3, "points")).balance) - before, 30n);
      const none = (await create(null)).id;
      await complete(none);
      assert.equal((await detail(3, none)).contributionOffer, null);
      assert.equal(BigInt((await c(3, "points")).balance) - before, 30n);
      const next = (await create(current.id)).id;
      await complete(next);
      assert.equal(BigInt((await c(3, "points")).balance) - before, 75n);
    },
  );
  await check(
    "exact concurrent creation retries preserve the offer even after its template is disabled",
    async () => {
      const current = (await rules()).find(
          (r: any) => r.templateId === template,
        ),
        key = randomUUID(),
        until = deadline();
      const payload = { key, deadline: until, startsAt: null };
      const [a, b] = await Promise.all([
        create(current.id, payload),
        create(current.id, payload),
      ]);
      assert.equal(a.id, b.id);
      const p = await propose(0, parameters(template, 2, 45, false));
      await vote(1, p.id);
      assert.equal((await create(current.id, payload)).id, a.id);
      await denied(create(current.id));
      await denied(create(null, payload), 409);
      assert.equal((await detail(2, a.id)).contributionOffer.amount, 45);
    },
  );
  await check(
    "invalid schedules and audit failures roll back the task, pinned offer and receipt",
    async () => {
      const key = randomUUID(),
        original = SecurityService.logAuditEventInTransaction;
      await denied(
        create(null, {
          startsAt: new Date(Date.now() + 7200000).toISOString(),
        }),
        400,
      );
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic template task audit outage");
      };
      try {
        await assert.rejects(create(null, { key }));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
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
    "stale template proposals conflict and do not overwrite a newer policy",
    async () => {
      const p = await propose(0, parameters(template, 2, 999));
      await denied(vote(1, p.id), 409);
      assert.equal(
        (await rules()).find((r: any) => r.templateId === template).version,
        3,
      );
    },
  );
  await check(
    "delegation preserves its parent offer and rejects attempts to replace it",
    async () => {
      const childUnit = randomUUID();
      await owner.query(
        "INSERT INTO units(organization_id,id,parent_id,name,kind) VALUES($1,$2,$3,'Synthetic mobilization group','authority')",
        [org, childUnit, region],
      );
      const parent = (await create(null)).id;
      const extra = {
        unitId: childUnit,
        title: "Delegated voluntary support",
        description: "Synthetic delegation",
        roleLabel: "Participant",
        priority: "normal",
        capacity: 1,
        deadline: new Date(Date.now() + 1800000).toISOString(),
      };
      await denied(
        act(2, "delegate", parent, { ...extra, contributionRuleId: first.id }),
        409,
      );
      const child = await act(2, "delegate", parent, extra);
      assert.equal((await detail(2, child.id)).contributionOffer, null);
      assert.equal((await detail(2, parent)).used, 1);
    },
  );
  await check(
    "moving a template scope invalidates new selection and published template history remains private",
    async () => {
      const id = randomUUID(),
        p = await propose(0, parameters(id));
      await vote(1, p.id);
      const offer = (await rules()).find((r: any) => r.templateId === id);
      const oldParent = (
        await owner.query(
          "SELECT parent_id FROM units WHERE organization_id=$1 AND id=$2",
          [org, region],
        )
      ).rows[0].parent_id;
      await owner.query(
        "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
        [org, region, sibling],
      );
      try {
        await denied(create(offer.id));
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, region, oldParent],
        );
      }
      const mine = await c(3, "points");
      assert.ok(
        mine.entries.some(
          (e: any) => e.rewardTitle === "Synthetic driving support",
        ),
      );
      await denied(
        c(4, "points", {
          memberId: access.accounts[3].memberId,
          unitId: region,
        }),
      );
    },
  );
}
