import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { testWorkOversight } from "./work-oversight-tests";
import { SecurityService } from "../backend/src/services/security";

export async function testWorkNeeds(
  args: Parameters<typeof testWorkOversight>[0],
) {
  const { command, act, detail, owner, access, check, denied } = args,
    org = access.organizationId,
    unit = access.accounts[2].unitId;
  const fresh = () => ({
    key: randomUUID(),
    unitId: unit,
    capacity: 3,
    title: "Synthetic needs task",
    description: "Synthetic only",
    roleLabel: "Volunteer",
    priority: "normal",
    deadline: new Date(Date.now() + 3600000).toISOString(),
  });
  const make = async () => (await command(2, "create", fresh())).id;
  const add = async (id: string, kind = "resource", extra: object = {}) => {
    await act(2, "need_create", id, {
      kind,
      title: "Synthetic " + kind,
      quantity: "2",
      unitLabel: kind === "people" ? "persons" : "units",
      gate: "optional",
      memberId: access.accounts[2].memberId,
      deadline: new Date((await detail(2, id)).deadline).toISOString(),
      qualificationIds: [],
      ...extra,
    });
    return (await detail(2, id)).needs.find((n: any) => n.kind === kind).id;
  };
  await check(
    "qualification authority is explicit and does not follow work manager rank",
    async () => {
      const id = await make();
      await act(2, "qualification_define", id, {
        title: "Synthetic first aid",
      });
      const q = (await detail(2, id)).qualificationCatalog.find(
        (v: any) => v.title === "Synthetic first aid",
      ).id;
      await act(2, "qualification_claim", id, {
        qualificationId: q,
        reference: "Synthetic training reference",
      });
      const claim = (await detail(2, id)).qualificationClaims[0].id;
      await denied(
        act(3, "qualification_verify", id, {
          claimId: claim,
          validUntil: new Date(Date.now() + 86400000).toISOString(),
          note: "Synthetic review",
        }),
      );
    },
  );
  const { enableDemoWorkNeeds } = await import("./web-demo-work-needs");
  await owner.query("BEGIN");
  await enableDemoWorkNeeds(owner, access);
  await owner.query("COMMIT");
  await check(
    "delegated roles inherit requirements and partial acceptance returns unallocated quota",
    async () => {
      const id = await make(),
        role = await add(id, "people", { quantity: "3" });
      const group = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 ORDER BY id LIMIT 1",
          [org, unit],
        )
      ).rows[0].id;
      const input = {
        unitId: group,
        title: "Synthetic inherited role",
        description: "Role allocation",
        roleLabel: "Volunteer",
        capacity: 2,
        priority: "normal",
        deadline: new Date((await detail(2, id)).deadline).toISOString(),
        needId: role,
      };
      const child = (await act(2, "delegate", id, input)).id;
      assert.equal(Number((await detail(2, child)).needs[0].quantity), 2);
      await denied(act(2, "delegate", id, input), 409);
      await act(2, "accept", child, {
        capacity: 1,
        note: "Partial capacity accepted",
      });
      assert.equal(Number((await detail(2, child)).needs[0].quantity), 1);
      await act(2, "delegate", id, input);
      await denied(
        act(2, "need_cancel", id, {
          needId: role,
          note: "Cannot discard delegated roles",
        }),
        409,
      );
    },
  );
  await check(
    "role quotas, independent qualifications, expiration and revocation are enforced",
    async () => {
      const id = await make();
      await act(2, "qualification_define", id, { title: "Synthetic driver" });
      const q = (await detail(2, id)).qualificationCatalog.find(
        (v: any) => v.title === "Synthetic driver",
      ).id;
      const role = await add(id, "people", {
        quantity: "1",
        qualificationIds: [q],
      });
      await denied(
        act(2, "need_create", id, {
          kind: "people",
          title: "Too many slots",
          quantity: "3",
          unitLabel: "people",
          gate: "optional",
          memberId: access.accounts[2].memberId,
          deadline: new Date((await detail(2, id)).deadline).toISOString(),
        }),
        409,
      );
      await denied(act(3, "apply", id), 400);
      await act(3, "apply", id, { needId: role });
      await denied(
        act(2, "assign", id, { memberId: access.accounts[3].memberId }),
      );
      await act(3, "qualification_claim", id, {
        qualificationId: q,
        reference: "Synthetic licence reference",
      });
      const claim = (await detail(3, id)).qualificationClaims[0].id;
      const approve = {
        claimId: claim,
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        note: "Independent training verification",
      };
      await denied(act(3, "qualification_verify", id, approve));
      await denied(act(4, "qualification_verify", id, approve));
      await act(2, "qualification_verify", id, approve);
      await act(2, "assign", id, { memberId: access.accounts[3].memberId });
      await act(3, "start", id);
      await act(3, "submit", id);
      await act(2, "qualification_revoke", id, {
        claimId: claim,
        note: "Synthetic qualification invalidated",
      });
      await denied(
        act(0, "verify", id, { memberId: access.accounts[3].memberId }),
      );
      assert.equal((await detail(2, id)).assignments[0].qualified, false);
      await denied(add(id, "resource"), 409);
    },
  );
  await check(
    "pledges do not meet gates; independent partial provision and returns preserve gaps",
    async () => {
      const id = await make(),
        need = await add(id, "resource", { gate: "start", quantity: "1.500" });
      await act(3, "apply", id);
      await act(2, "assign", id, { memberId: access.accounts[3].memberId });
      await denied(act(3, "start", id), 409);
      await act(3, "provision_offer", id, {
        needId: need,
        quantity: "0.750",
        note: "Synthetic equipment",
      });
      let n = (await detail(2, id)).needs[0];
      assert.equal(Number(n.confirmed), 0);
      assert.equal(Number(n.pledged), 0.75);
      await denied(
        act(3, "provision_confirm", id, {
          provisionId: n.provisions[0].id,
          note: "Self confirmation denied",
        }),
      );
      await act(2, "provision_confirm", id, {
        provisionId: n.provisions[0].id,
        note: "Delivery checked",
      });
      await denied(act(3, "start", id), 409);
      await act(3, "provision_offer", id, { needId: need, quantity: "0.750" });
      n = (await detail(2, id)).needs[0];
      const second = n.provisions.find((p: any) => p.status === "pledged").id;
      await act(2, "provision_confirm", id, {
        provisionId: second,
        note: "Second delivery checked",
      });
      await act(3, "start", id);
      await act(2, "provision_return", id, {
        provisionId: second,
        note: "Equipment returned",
      });
      n = (await detail(2, id)).needs[0];
      assert.equal(Number(n.remaining), 0.75);
      await act(3, "submit", id);
      await act(0, "verify", id, { memberId: access.accounts[3].memberId });
      await denied(act(2, "complete", id), 409);
    },
  );
  await check(
    "concurrent last resource confirmations cannot overallocate; retries and audit rollback are exact",
    async () => {
      const id = await make(),
        need = await add(id, "service", { quantity: "1" });
      await act(3, "provision_offer", id, { needId: need, quantity: "1" });
      await act(3, "provision_offer", id, { needId: need, quantity: "1" });
      const d = await detail(2, id),
        provisions = d.needs[0].provisions;
      const inputs = provisions.map((p: any) => ({
        id,
        version: d.version,
        key: randomUUID(),
        provisionId: p.id,
        note: "Independent acceptance",
      }));
      const results = await Promise.allSettled(
        inputs.map((input: any) => command(2, "provision_confirm", input)),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const winner = results.findIndex((r) => r.status === "fulfilled");
      assert.deepEqual(
        await command(2, "provision_confirm", inputs[winner]),
        (results[winner] as PromiseFulfilledResult<any>).value,
      );
      assert.equal(Number((await detail(2, id)).needs[0].confirmed), 1);
      const before = (await detail(2, id)).version,
        original = SecurityService.logAuditEventInTransaction;
      try {
        SecurityService.logAuditEventInTransaction = async () => {
          throw new Error("Synthetic needs audit failure");
        };
        await assert.rejects(
          command(2, "provision_return", {
            id,
            version: before,
            key: randomUUID(),
            provisionId: provisions[winner].id,
            note: "Synthetic return",
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal((await detail(2, id)).version, before);
      assert.equal(Number((await detail(2, id)).needs[0].confirmed), 1);
    },
  );
}
