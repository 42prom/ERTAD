import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DemoAccess } from "../backend/src/localDemo";
import type {
  CollectiveOperation,
  collectiveCommand,
} from "../backend/src/modules/governance/collective";
import { reviewCommand } from "../backend/src/modules/governance/reviews";
import type { AdminSessionIdentity } from "../backend/src/services/adminSession";

export async function testPositionRetirement(
  owner: Client,
  access: DemoAccess,
  sessions: Pick<AdminSessionIdentity, "sessionId" | "sessionTokenHash">[],
  command: (
    i: number,
    op: CollectiveOperation,
    input?: object,
  ) => ReturnType<typeof collectiveCommand>,
  check: (name: string, fn: () => Promise<void>) => Promise<void>,
) {
  const org = access.organizationId,
    unit = access.accounts[2].unitId;
  const denied = (p: Promise<unknown>, code = 409) =>
    assert.rejects(
      p,
      (e: unknown) => (e as { statusCode: number }).statusCode === code,
    );
  const vote = (id: string, extra = {}) => ({
    id,
    version: 1,
    key: randomUUID(),
    choice: "approve",
    reason: "Synthetic independent retirement review",
    ...extra,
  });
  async function unused(name = `Synthetic unused ${randomUUID()}`) {
    const p = await command(0, "propose", {
      key: randomUUID(),
      unitId: unit,
      kind: "position_create",
      reason: "Synthetic position for retirement",
      deadline: new Date(Date.now() + 86400000).toISOString(),
      parameters: {
        name,
        grants: [{ permission: "unit.read", scope: "unit" }],
      },
    });
    await command(1, "vote", vote(p.id));
    return p.id as string;
  }
  async function payload(id: string) {
    const p = (
      await owner.query(
        "SELECT * FROM positions WHERE organization_id=$1 AND id=$2",
        [org, id],
      )
    ).rows[0];
    return {
      key: randomUUID(),
      unitId: unit,
      kind: "position_retire",
      reason: "Retire unused synthetic position",
      deadline: new Date(Date.now() + 86400000).toISOString(),
      parameters: {
        sourceId: id,
        sourceVersion: p.version,
        sourceName: p.name,
      },
    };
  }
  const status = async (id: string) =>
    (await owner.query("SELECT status FROM positions WHERE id=$1", [id]))
      .rows[0].status;
  const memberships = async () =>
    JSON.stringify(
      (
        await owner.query(
          "SELECT to_jsonb(m) AS data FROM memberships m ORDER BY organization_id,id",
        )
      ).rows,
    );
  async function member(position: string, state = "active", future = false) {
    const id = randomUUID();
    await owner.query("INSERT INTO member_users(id) VALUES($1)", [id]);
    return (
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,status,valid_from,valid_until) VALUES($1,$2,$3,$4,1,$5,now()+$6::interval,now()+interval '3 days') RETURNING id",
        [org, id, unit, position, state, future ? "1 day" : "-1 day"],
      )
    ).rows[0].id as string;
  }
  await check(
    "unused position retires once after independent review; memberships and permission definitions are preserved",
    async () => {
      const id = await unused(),
        input = await payload(id),
        before = await memberships();
      const grants = JSON.stringify(
        (
          await owner.query(
            "SELECT to_jsonb(g) data FROM permission_grants g ORDER BY organization_id,bundle_id,bundle_version,permission,scope",
          )
        ).rows,
      );
      await denied(command(4, "propose", input), 403);
      const p = await command(0, "propose", input);
      assert.deepEqual(await command(0, "propose", input), p);
      await denied(command(0, "vote", vote(p.id)), 403);
      const request = vote(p.id),
        results = await Promise.all([
          command(1, "vote", request),
          command(1, "vote", request),
        ]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(await status(id), "retired");
      assert.equal(await memberships(), before);
      assert.equal(
        JSON.stringify(
          (
            await owner.query(
              "SELECT to_jsonb(g) data FROM permission_grants g ORDER BY organization_id,bundle_id,bundle_version,permission,scope",
            )
          ).rows,
        ),
        grants,
      );
      const list = await command(0, "positions", {
        search: input.parameters.sourceName,
      });
      assert.equal(list.items[0].canRetire, false);
      assert.equal(list.items[0].canRevise, false);
      await denied(
        reviewCommand(sessions[0], "propose", {
          organizationId: org,
          key: randomUUID(),
          targetId: access.accounts[2].memberId,
          positionId: id,
          reason: "Synthetic appointment to retired position",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          validUntil: new Date(Date.now() + 172800000).toISOString(),
        }),
        409,
      );
    },
  );
  await check(
    "active, scheduled and suspended memberships block retirement without disclosing their identities",
    async () => {
      for (const [state, future] of [
        ["active", false],
        ["active", true],
        ["suspended", false],
      ] as const) {
        const id = await unused(),
          m = await member(id, state, future),
          input = await payload(id);
        await denied(command(0, "propose", input));
        const row = (
          await command(0, "positions", { search: input.parameters.sourceName })
        ).items[0];
        assert.equal(row.retirementBlocked, true);
        assert.equal("members" in row, false);
        await owner.query("UPDATE memberships SET status='ended' WHERE id=$1", [
          m,
        ]);
        const before = await memberships(),
          p = await command(0, "propose", input);
        await command(1, "vote", vote(p.id));
        assert.equal(await memberships(), before);
      }
    },
  );
  await check(
    "pending appointment and definition revision must be resolved before retirement",
    async () => {
      const id = await unused(),
        input = await payload(id);
      const appointment = await reviewCommand(sessions[0], "propose", {
        organizationId: org,
        key: randomUUID(),
        targetId: access.accounts[2].memberId,
        positionId: id,
        reason: "Synthetic pending appointment",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        validUntil: new Date(Date.now() + 172800000).toISOString(),
      });
      await denied(command(0, "propose", input));
      await reviewCommand(sessions[1], "decide", {
        organizationId: org,
        key: randomUUID(),
        id: appointment.id,
        decision: "rejected",
        reason: "Synthetic independent rejection",
      });
      const revision = await command(0, "propose", {
        ...input,
        key: randomUUID(),
        kind: "position_revision",
        parameters: {
          sourceId: id,
          sourceVersion: 0,
          name: "Synthetic replacement " + randomUUID(),
          grants: [{ permission: "unit.read", scope: "unit" }],
        },
      });
      await denied(command(0, "propose", input));
      await command(0, "withdraw", {
        id: revision.id,
        version: 1,
        key: randomUUID(),
      });
      const p = await command(0, "propose", input);
      await command(1, "vote", vote(p.id));
      assert.equal(await status(id), "retired");
    },
  );
  await check(
    "new membership after proposal blocks approval; a stale source can still be rejected",
    async () => {
      const id = await unused(),
        p = await command(0, "propose", await payload(id));
      await member(id);
      await denied(command(1, "vote", vote(p.id)));
      assert.equal(await status(id), "active");
      await owner.query(
        "UPDATE positions SET name=name||' changed' WHERE id=$1",
        [id],
      );
      await denied(command(1, "vote", vote(p.id)));
      await command(1, "vote", vote(p.id, { choice: "reject" }));
      const detail = await command(0, "detail", { id: p.id });
      assert.equal(detail.version, 2);
      await command(0, "withdraw", { id: p.id, version: 2, key: randomUUID() });
      assert.equal(
        (await command(0, "detail", { id: p.id })).status,
        "withdrawn",
      );
    },
  );
  await check(
    "competing retirement requests and changed retry payloads cannot apply twice",
    async () => {
      const id = await unused(),
        input = await payload(id),
        p = await command(0, "propose", input),
        q = await command(2, "propose", { ...input, key: randomUUID() });
      await denied(
        command(0, "propose", {
          ...input,
          reason: "Different retirement intent",
        }),
      );
      await command(1, "vote", vote(p.id));
      await denied(command(3, "vote", vote(q.id)));
      assert.equal(
        (await owner.query("SELECT version FROM positions WHERE id=$1", [id]))
          .rows[0].version,
        1,
      );
    },
  );
  await check(
    "audit outage and post-audit source tampering roll back retirement and its vote",
    async () => {
      const id = await unused(),
        p = await command(0, "propose", await payload(id));
      await owner.query(
        "CREATE FUNCTION retirement_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='COLLECTIVE_COMMAND' THEN RAISE EXCEPTION 'Synthetic retirement audit outage'; END IF; RETURN NEW; END $$; CREATE TRIGGER retirement_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION retirement_audit_failure()",
      );
      try {
        await assert.rejects(command(1, "vote", vote(p.id)));
      } finally {
        await owner.query(
          "DROP TRIGGER retirement_audit_failure ON audit_log; DROP FUNCTION retirement_audit_failure()",
        );
      }
      await owner.query(
        `CREATE FUNCTION retirement_audit_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='COLLECTIVE_COMMAND' THEN UPDATE ertad.positions SET name='Synthetic tampering' WHERE id='${id}'::uuid; END IF; RETURN NEW; END $$; CREATE TRIGGER retirement_audit_tamper AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION retirement_audit_tamper()`,
      );
      try {
        await denied(command(1, "vote", vote(p.id)));
      } finally {
        await owner.query(
          "DROP TRIGGER retirement_audit_tamper ON audit_log; DROP FUNCTION retirement_audit_tamper()",
        );
      }
      assert.equal(await status(id), "active");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM collective_votes WHERE proposal_id=$1",
            [p.id],
          )
        ).rows[0].n,
        0,
      );
      await command(1, "vote", vote(p.id));
    },
  );
  await check(
    "post-audit new membership and proposer revocation invalidate retirement",
    async () => {
      const id = await unused(),
        p = await command(0, "propose", await payload(id)),
        user = randomUUID();
      await owner.query("INSERT INTO member_users(id) VALUES($1)", [user]);
      await owner.query(
        `CREATE FUNCTION retirement_membership_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='COLLECTIVE_COMMAND' THEN INSERT INTO ertad.memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from) VALUES('${org}','${user}','${unit}','${id}',1,now()); END IF; RETURN NEW; END $$; CREATE TRIGGER retirement_membership_tamper AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION retirement_membership_tamper()`,
      );
      try {
        await denied(command(1, "vote", vote(p.id)));
      } finally {
        await owner.query(
          "DROP TRIGGER retirement_membership_tamper ON audit_log; DROP FUNCTION retirement_membership_tamper()",
        );
      }
      assert.equal(await status(id), "active");
      await owner.query(
        `CREATE FUNCTION retirement_authority_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='COLLECTIVE_COMMAND' THEN UPDATE ertad.memberships SET status='suspended' WHERE user_id='${access.accounts[0].memberId}'::uuid; END IF; RETURN NEW; END $$; CREATE TRIGGER retirement_authority_tamper AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION retirement_authority_tamper()`,
      );
      try {
        await denied(command(1, "vote", vote(p.id)), 403);
      } finally {
        await owner.query(
          "DROP TRIGGER retirement_authority_tamper ON audit_log; DROP FUNCTION retirement_authority_tamper()",
        );
      }
      assert.equal(await status(id), "active");
      await command(1, "vote", vote(p.id));
    },
  );
  return await unused("Retirement browser position");
}
