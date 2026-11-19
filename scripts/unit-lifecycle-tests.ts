import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type request from "supertest";
import type { DemoAccess } from "../backend/src/localDemo";
import { unitCommand } from "../backend/src/modules/organization/units";
import { inboxCommand } from "../backend/src/modules/communication/inbox";
import { enableDemoUnitChanges } from "./web-demo-unit-changes";
import { SecurityService } from "../backend/src/services/security";

type Session = {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  sessionId: string;
  sessionTokenHash: string;
};
export async function testUnitLifecycle(
  owner: Client,
  access: DemoAccess,
  sessions: Session[],
) {
  const org = access.organizationId,
    region = access.accounts[2].unitId;
  let checks = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    await fn();
    checks++;
    console.log("PASS " + name);
  };
  const command = (
    i: number,
    op: Parameters<typeof unitCommand>[1],
    input: object = {},
  ) => unitCommand(sessions[i], op, { organizationId: org, ...input });
  const denied = (p: Promise<unknown>, status = 403) =>
    assert.rejects(
      p,
      (e: unknown) => (e as { statusCode?: number }).statusCode === status,
    );
  const unit = async (parent = region) =>
    (
      await owner.query(
        "INSERT INTO units(organization_id,parent_id,name,kind) VALUES($1,$2,$3,'authority') RETURNING *",
        [org, parent, "Synthetic lifecycle " + randomUUID().slice(0, 8)],
      )
    ).rows[0];
  const change = (
    u: { id: string; version: number },
    kind: "rename" | "archive" | "restore" = "rename",
  ) => ({
    key: randomUUID(),
    unitId: u.id,
    version: u.version,
    kind,
    ...(kind === "rename"
      ? { name: "Renamed " + randomUUID().slice(0, 8) }
      : {}),
    reason: "Synthetic independently reviewed change",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const decide = (id: string) => ({
    id,
    key: randomUUID(),
    decision: "approved",
    reason: "Independent synthetic approval",
  });
  const row = async (id: string) =>
    (
      await owner.query(
        "SELECT * FROM units WHERE organization_id=$1 AND id=$2",
        [org, id],
      )
    ).rows[0];
  const first = await unit(),
    proposal = change(first);
  await check(
    "creation grants do not implicitly grant rename/archive authority",
    async () => {
      await denied(command(2, "change", proposal));
      const before = Number(
        (await owner.query("SELECT count(*) FROM memberships")).rows[0].count,
      );
      await owner.query("BEGIN");
      await enableDemoUnitChanges(owner, access);
      await owner.query("COMMIT");
      const after = Number(
        (await owner.query("SELECT count(*) FROM memberships")).rows[0].count,
      );
      assert.equal(after, before + 6);
      await owner.query("BEGIN");
      await enableDemoUnitChanges(owner, access);
      await owner.query("COMMIT");
      assert.equal(
        Number(
          (await owner.query("SELECT count(*) FROM memberships")).rows[0].count,
        ),
        after,
      );
    },
  );
  let review: { id: string; status: string };
  await check(
    "changes are immutable, scoped, independent and idempotent before approval",
    async () => {
      review = await command(2, "change", proposal);
      assert.deepEqual(await command(2, "change", proposal), review);
      assert.equal((await row(first.id)).name, first.name);
      await denied(
        command(2, "change", { ...proposal, name: "Conflicting retry" }),
        409,
      );
      await denied(
        command(2, "propose", {
          key: proposal.key,
          parentId: region,
          name: proposal.name,
          reason: proposal.reason,
          expiresAt: proposal.expiresAt,
        }),
        409,
      );
      await denied(command(2, "decide", decide(review.id)));
      await denied(command(4, "detail", { id: review.id }));
      await denied(command(4, "change", change(first)));
      await denied(
        command(2, "change", {
          ...change(first),
          organizationId: randomUUID(),
        }),
      );
      const root = (
        await owner.query(
          "SELECT id,version FROM units WHERE organization_id=$1 AND parent_id IS NULL",
          [org],
        )
      ).rows[0];
      await denied(command(0, "change", change(root)));
      await assert.rejects(
        owner.query("UPDATE unit_reviews SET target_version=9 WHERE id=$1", [
          review.id,
        ]),
      );
      const detail = await command(3, "detail", { id: review.id });
      assert.equal(detail.kind, "rename");
      assert.equal(detail.original_name, first.name);
      const inbox = await inboxCommand(sessions[3], "list", {
        organizationId: org,
        source: "unit",
        view: "all",
        page: 1,
      });
      assert.ok(
        inbox.items.some(
          (r: { id: string; action: string }) =>
            r.id === review.id && r.action === "review",
        ),
      );
    },
  );
  await check(
    "concurrent approval renames once and preserves unit identity/ancestry",
    async () => {
      const payload = decide(review.id);
      const [a, b] = await Promise.all([
        command(3, "decide", payload),
        command(3, "decide", payload),
      ]);
      assert.deepEqual(a, b);
      const updated = await row(first.id);
      assert.equal(updated.version, 1);
      assert.equal(updated.parent_id, region);
      assert.equal(updated.name, proposal.name);
      assert.equal(updated.status, "active");
      assert.equal((await command(2, "change", proposal)).status, "approved");
      await denied(
        command(3, "decide", { ...payload, decision: "rejected" }),
        409,
      );
    },
  );
  await check(
    "stale versions and duplicate sibling names cannot overwrite accepted changes",
    async () => {
      await denied(command(2, "change", change(first)), 409);
      const fresh = await row(first.id);
      const stale = await command(2, "change", change(fresh));
      const winning = await command(2, "change", change(fresh));
      await command(3, "decide", decide(winning.id));
      await denied(command(3, "decide", decide(stale.id)), 409);
      const duplicate = await unit(),
        current = await row(first.id);
      const collision = await command(2, "change", {
        ...change(duplicate),
        name: current.name.toUpperCase(),
      });
      await denied(command(3, "decide", decide(collision.id)), 409);
      assert.equal((await row(duplicate.id)).version, 0);
    },
  );
  await check(
    "archival explains children and attached history; roots cannot be archived",
    async () => {
      const parent = await unit();
      await unit(parent.id);
      await denied(command(2, "change", change(parent, "archive")), 409);
      const qualified = await unit();
      await owner.query(
        "INSERT INTO qualification_definitions(organization_id,unit_id,title) VALUES($1,$2,'Synthetic qualification')",
        [org, qualified.id],
      );
      await denied(command(2, "change", change(qualified, "archive")), 409);
      const list = await command(2, "units", { search: qualified.name });
      assert.ok(list.items[0].archiveBlockers.includes("qualifications"));
      const regional = await row(region);
      await denied(command(0, "change", change(regional, "archive")), 409);
    },
  );
  await check(
    "new dependencies after proposal prevent archival without preventing rejection",
    async () => {
      const target = await unit(),
        pending = await command(2, "change", change(target, "archive"));
      await unit(target.id);
      await denied(command(3, "decide", decide(pending.id)), 409);
      await command(3, "decide", {
        ...decide(pending.id),
        decision: "rejected",
      });
      assert.equal((await row(target.id)).status, "active");
    },
  );
  await check(
    "empty unit archival retains scoped history and exact retries without deletion",
    async () => {
      const target = await unit(),
        payload = change(target, "archive"),
        pending = await command(2, "change", payload),
        decision = decide(pending.id);
      const before = Number(
        (await owner.query("SELECT count(*) FROM units")).rows[0].count,
      );
      const [a, b] = await Promise.all([
        command(3, "decide", decision),
        command(3, "decide", decision),
      ]);
      assert.deepEqual(a, b);
      assert.equal((await row(target.id)).status, "archived");
      assert.equal((await row(target.id)).version, 1);
      assert.equal(
        Number((await owner.query("SELECT count(*) FROM units")).rows[0].count),
        before,
      );
      assert.equal(
        (await command(2, "units", { search: target.name })).total,
        0,
      );
      assert.equal(
        (await command(2, "units", { search: target.name, status: "archived" }))
          .total,
        1,
      );
      assert.equal(
        (await command(4, "units", { search: target.name, status: "archived" }))
          .total,
        0,
      );
      assert.equal(
        (await command(3, "detail", { id: pending.id })).status,
        "approved",
      );
      assert.equal((await command(2, "change", payload)).status, "approved");
      await denied(command(2, "change", change(await row(target.id))), 409);
      const restoration = await command(
        2,
        "change",
        change(await row(target.id), "restore"),
      );
      await denied(command(2, "decide", decide(restoration.id)));
      const collision = await unit();
      await owner.query("UPDATE units SET name=$1 WHERE id=$2", [
        target.name,
        collision.id,
      ]);
      await denied(command(3, "decide", decide(restoration.id)), 409);
      await owner.query("UPDATE units SET name=$1 WHERE id=$2", [
        collision.name,
        collision.id,
      ]);
      const restoreDecision = decide(restoration.id);
      await command(3, "decide", restoreDecision);
      await command(3, "decide", restoreDecision);
      assert.equal((await row(target.id)).status, "active");
      assert.equal((await row(target.id)).version, 2);
      assert.equal(
        (await command(2, "units", { search: target.name, status: "archived" }))
          .total,
        0,
      );
      assert.equal(
        (await command(3, "detail", { id: pending.id })).status,
        "approved",
      );
    },
  );
  await check(
    "audit failure rolls back both name/version and approval",
    async () => {
      const target = await unit(),
        pending = await command(2, "change", change(target));
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic audit unavailable");
      };
      try {
        await assert.rejects(command(3, "decide", decide(pending.id)));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.equal((await row(target.id)).name, target.name);
      assert.equal((await row(target.id)).version, 0);
      assert.equal(
        (await command(3, "detail", { id: pending.id })).status,
        "pending",
      );
    },
  );
  await check(
    "post-audit dependency change rolls back archival and the injected child",
    async () => {
      const target = await unit(),
        pending = await command(2, "change", change(target, "archive"));
      await owner.query(
        "CREATE FUNCTION lifecycle_dependency() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='UNIT_REVIEW' THEN INSERT INTO ertad.units(organization_id,parent_id,name,kind) VALUES('" +
          org +
          "','" +
          target.id +
          "','Synthetic late child','authority'); END IF; RETURN NEW; END $$; CREATE TRIGGER lifecycle_dependency BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION lifecycle_dependency()",
      );
      try {
        await denied(command(3, "decide", decide(pending.id)), 409);
      } finally {
        await owner.query(
          "DROP TRIGGER lifecycle_dependency ON audit_log;DROP FUNCTION lifecycle_dependency()",
        );
      }
      assert.equal((await row(target.id)).status, "active");
      assert.equal(
        Number(
          (
            await owner.query("SELECT count(*) FROM units WHERE parent_id=$1", [
              target.id,
            ])
          ).rows[0].count,
        ),
        0,
      );
    },
  );
  await check(
    "proposer revocation, expiry and ancestry drift fail closed",
    async () => {
      const target = await unit(),
        pending = await command(2, "change", change(target));
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE user_id=$1 AND position_id IN(SELECT id FROM positions WHERE name='Unit lifecycle demo')",
        [access.accounts[2].memberId],
      );
      await denied(command(3, "decide", decide(pending.id)), 409);
      await owner.query(
        "UPDATE memberships SET status='active' WHERE user_id=$1 AND position_id IN(SELECT id FROM positions WHERE name='Unit lifecycle demo')",
        [access.accounts[2].memberId],
      );
      await owner.query("UPDATE units SET parent_id=$1 WHERE id=$2", [
        access.accounts[4].unitId,
        target.id,
      ]);
      await denied(command(1, "decide", decide(pending.id)), 409);
      await denied(
        command(2, "change", {
          ...change(await unit()),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
        400,
      );
    },
  );
  await check(
    "HTTP changes require Origin/CSRF/step-up and reject unknown or inconsistent fields",
    async () => {
      const target = await unit(),
        payload = { organizationId: org, ...change(target) };
      const agent = sessions[2].agent,
        path = "/api/v1/admin/units/changes";
      await agent.post(path).send(payload).expect(403);
      await agent
        .post(path)
        .set("Origin", "http://localhost:15173")
        .send(payload)
        .expect(403);
      const post = (body: object) =>
        agent
          .post(path)
          .set("Origin", "http://localhost:15173")
          .set("X-Admin-Csrf", sessions[2].csrf)
          .send(body);
      await post({ ...payload, role: "superadmin" }).expect(400);
      await post({ ...payload, kind: "archive" }).expect(400);
      await owner.query(
        "UPDATE admin_sessions SET step_up_expires_at=NULL WHERE id=$1",
        [sessions[2].sessionId],
      );
      await post(payload).expect(428);
      await owner.query(
        "UPDATE admin_sessions SET step_up_expires_at=now()+interval '5 minutes' WHERE id=$1",
        [sessions[2].sessionId],
      );
      const result = await post(payload).expect(200);
      assert.match(result.headers["cache-control"], /no-store/);
    },
  );
  return checks;
}
