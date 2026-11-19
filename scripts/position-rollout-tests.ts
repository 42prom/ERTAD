import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DemoAccess } from "../backend/src/localDemo";
import type {
  ReviewOperation,
  reviewCommand,
} from "../backend/src/modules/governance/reviews";
type Fixture = {
  user: string;
  source: string;
  dest: string;
  m: { id: string; version: number };
};
export async function testPositionRollout({
  owner,
  access,
  command,
  fixture,
  work,
  check,
}: {
  owner: Client;
  access: DemoAccess;
  command: (
    i: number,
    op: ReviewOperation,
    input?: object,
  ) => ReturnType<typeof reviewCommand>;
  fixture: () => Promise<Fixture>;
  work: (f: Fixture, status?: string) => Promise<string>;
  check: (name: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const org = access.organizationId,
    unit = access.accounts[2].unitId;
  const deny = (p: Promise<unknown>, status = 409) =>
    assert.rejects(
      p,
      (e: unknown) => (e as { statusCode: number }).statusCode === status,
    );
  async function revision() {
    const f = await fixture(),
      bundle = randomUUID();
    await owner.query(
      "INSERT INTO permission_bundles(organization_id,id,version,status) VALUES($1,$2,1,'draft')",
      [org, bundle],
    );
    await owner.query(
      "INSERT INTO permission_grants VALUES($1,$2,1,'unit.read','subtree')",
      [org, bundle],
    );
    await owner.query(
      "UPDATE permission_bundles SET status='approved' WHERE id=$1",
      [bundle],
    );
    const originalBundle = randomUUID();
    await owner.query(
      "INSERT INTO permission_bundles(organization_id,id,version,status) VALUES($1,$2,1,'draft')",
      [org, originalBundle],
    );
    await owner.query(
      "INSERT INTO permission_grants VALUES($1,$2,1,'unit.read','unit')",
      [org, originalBundle],
    );
    await owner.query(
      "UPDATE permission_bundles SET status='approved' WHERE id=$1",
      [originalBundle],
    );
    await owner.query("UPDATE positions SET bundle_id=$1 WHERE id=$2", [
      originalBundle,
      f.source,
    ]);
    await owner.query(
      "UPDATE positions SET unit_id=$1,predecessor_id=$2,revision=2,bundle_id=$3,name='Synthetic adopted role' WHERE id=$4",
      [unit, f.source, bundle, f.dest],
    );
    return f;
  }
  const row = async (id: string) =>
    (await owner.query("SELECT * FROM memberships WHERE id=$1", [id])).rows[0];
  const options = (f: Fixture, i = 0) =>
    command(i, "revisionOptions", { positionId: f.dest });
  const input = async (f: Fixture) => ({
    kind: "revision",
    positionId: f.dest,
    membershipId: f.m.id,
    version: (await row(f.m.id)).version,
    definitionKey: (await options(f)).definitionKey,
    key: randomUUID(),
    reason: "Synthetic controlled position adoption",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const decision = (id: string, decision = "approved") => ({
    id,
    decision,
    key: randomUUID(),
    reason: "Synthetic independent adoption review",
  });
  async function history() {
    const values = [];
    for (const table of [
      "work_assignments",
      "activity_entries",
      "contribution_entries",
    ])
      values.push(
        (
          await owner.query(
            `SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      );
    return values;
  }
  await check(
    "revision comparison is scoped, paginated, exact-searchable and cannot be self-assigned",
    async () => {
      const f = await revision(),
        o = await options(f, 2);
      assert.equal(o.items.length, 1);
      assert.equal(o.items[0].blocker, null);
      assert.ok(
        o.comparison.added.some(
          (g: { scope: string }) => g.scope === "subtree",
        ),
      );
      await deny(options(f, 4), 403);
      await deny(
        command(0, "revisionOptions", {
          positionId: f.dest,
          organizationId: randomUUID(),
        }),
        403,
      );
      assert.equal(
        (
          await command(0, "revisionOptions", {
            positionId: f.dest,
            search: f.user,
          })
        ).total,
        1,
      );
      assert.equal(
        (await command(0, "revisionOptions", { positionId: f.dest, page: 2 }))
          .items.length,
        0,
      );
      await deny(
        command(0, "revisionOptions", { positionId: f.dest, page: 0 }),
        400,
      );
      await owner.query("UPDATE memberships SET user_id=$1 WHERE id=$2", [
        access.accounts[0].memberId,
        f.m.id,
      ]);
      assert.equal((await options(f)).items[0].blocker, "self");
      await deny(command(0, "change", await input(f)), 403);
    },
  );
  await check(
    "adoption preserves unbounded terms, history and independent approval; concurrent retries apply once",
    async () => {
      const f = await revision();
      const earnedBefore = await history();
      await owner.query("UPDATE memberships SET valid_until=NULL WHERE id=$1", [
        f.m.id,
      ]);
      const before = await row(f.m.id),
        payload = await input(f),
        r = await command(0, "change", payload);
      assert.deepEqual(await command(0, "change", payload), r);
      await deny(
        command(0, "change", { ...payload, reason: "Different retry content" }),
      );
      await deny(command(0, "decide", decision(r.id)), 403);
      await deny(command(4, "decide", decision(r.id)), 403);
      const detail = await command(1, "detail", { id: r.id });
      assert.equal(detail.comparison.destinationName, "Synthetic adopted role");
      assert.equal(detail.source_snapshot, undefined);
      assert.equal(detail.revision_snapshot, undefined);
      assert.equal((await options(f)).items[0].blocker, "pending");
      await deny(command(0, "change", { ...payload, key: randomUUID() }));
      const d = decision(r.id);
      assert.deepEqual(
        ...((await Promise.all([
          command(1, "decide", d),
          command(1, "decide", d),
        ])) as [unknown, unknown]),
      );
      const after = (
        await owner.query(
          "SELECT * FROM memberships WHERE user_id=$1 ORDER BY id",
          [f.user],
        )
      ).rows;
      assert.equal(after.length, 2);
      assert.deepEqual(
        after.find((m) => m.id === f.m.id),
        { ...before, status: "ended", version: before.version + 1 },
      );
      const adopted = after.find((m) => m.position_id === f.dest);
      assert.deepEqual(adopted, {
        ...before,
        id: adopted.id,
        position_id: f.dest,
        version: 0,
      });
      assert.equal((await options(f)).items[0].review.status, "approved");
      assert.equal((await command(0, "change", payload)).id, r.id);
      assert.deepEqual(await history(), earnedBefore);
      assert.equal(
        (
          await owner.query(
            "SELECT ertad.position_retirement_blocked($1,$2) blocked",
            [org, f.dest],
          )
        ).rows[0].blocked,
        true,
      );
    },
  );
  await check(
    "scheduled and suspended memberships retain state and dates; expired terms cannot move",
    async () => {
      for (const state of ["scheduled", "suspended", "expired"]) {
        const f = await revision();
        await owner.query(
          state === "scheduled"
            ? "UPDATE memberships SET valid_from=now()+interval '2 days' WHERE id=$1"
            : state === "suspended"
              ? "UPDATE memberships SET status='suspended' WHERE id=$1"
              : "UPDATE memberships SET valid_from=now()-interval '3 days',valid_until=now()-interval '1 day' WHERE id=$1",
          [f.m.id],
        );
        const before = await row(f.m.id),
          payload = await input(f);
        if (state === "expired") {
          await deny(command(0, "change", payload));
          continue;
        }
        const r = await command(0, "change", payload);
        await command(1, "decide", decision(r.id));
        const n = (
          await owner.query(
            "SELECT * FROM memberships WHERE user_id=$1 AND position_id=$2",
            [f.user, f.dest],
          )
        ).rows[0];
        assert.deepEqual(n, {
          ...before,
          id: n.id,
          position_id: f.dest,
          version: 0,
        });
        assert.equal(
          (
            await owner.query(
              "SELECT ertad.review_has_scope($1,$2,$3,'unit.read') ok",
              [f.user, org, unit],
            )
          ).rows[0].ok,
          false,
        );
      }
    },
  );
  await check(
    "active work, unrelated destinations, overlaps and stale definitions block adoption",
    async () => {
      const f = await revision(),
        initial = await input(f);
      await work(f);
      assert.equal((await options(f)).items[0].blocker, "responsibilities");
      await deny(command(0, "change", initial));
      const g = await revision(),
        stale = await input(g);
      await owner.query(
        "UPDATE positions SET name='Changed reviewed definition' WHERE id=$1",
        [g.dest],
      );
      await deny(command(0, "change", stale));
      await deny(
        command(0, "change", { ...(await input(g)), positionId: f.dest }),
        403,
      );
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,status,valid_from) VALUES($1,$2,$3,$4,1,'suspended',now())",
        [org, g.user, unit, g.dest],
      );
      assert.equal((await options(g)).items[0].blocker, "overlap");
      await deny(command(0, "change", await input(g)));
    },
  );
  await check(
    "changed grants invalidate approval, frozen comparison remains reviewable and rejection still works",
    async () => {
      const f = await revision(),
        r = await command(0, "change", await input(f));
      await assert.rejects(
        owner.query(
          "DELETE FROM permission_grants WHERE bundle_id=(SELECT bundle_id FROM positions WHERE id=$1)",
          [f.dest],
        ),
      );
      await owner.query(
        "UPDATE positions SET bundle_id=(SELECT bundle_id FROM positions WHERE id=$1) WHERE id=$2",
        [f.source, f.dest],
      );
      await deny(command(1, "decide", decision(r.id)));
      assert.equal(
        (await command(1, "detail", { id: r.id })).comparison.added.length,
        1,
      );
      await command(1, "decide", decision(r.id, "rejected"));
      assert.equal((await row(f.m.id)).status, "active");
    },
  );
  await check(
    "audit failure and post-audit source/term/authority tampering roll back adoption and notices",
    async () => {
      const f = await revision(),
        r = await command(0, "change", await input(f)),
        before = await row(f.m.id);
      for (const statement of [
        "RAISE EXCEPTION 'Synthetic audit outage'",
        `UPDATE ertad.memberships SET valid_until=valid_until+interval '1 day' WHERE user_id='${f.user}'`,
        `UPDATE ertad.positions SET status='retired' WHERE id='${f.dest}'`,
        `UPDATE ertad.memberships SET status='suspended' WHERE user_id='${access.accounts[0].memberId}'`,
      ]) {
        await owner.query(
          `CREATE FUNCTION rollout_audit_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='MEMBERSHIP_REVIEW' THEN ${statement}; END IF; RETURN NEW; END $$; CREATE TRIGGER rollout_audit_tamper AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION rollout_audit_tamper()`,
        );
        try {
          await assert.rejects(command(1, "decide", decision(r.id)));
        } finally {
          await owner.query(
            "DROP TRIGGER rollout_audit_tamper ON audit_log; DROP FUNCTION rollout_audit_tamper()",
          );
        }
        assert.deepEqual(await row(f.m.id), before);
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int n FROM memberships WHERE user_id=$1",
              [f.user],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int n FROM review_notifications WHERE review_id=$1",
              [r.id],
            )
          ).rows[0].n,
          0,
        );
      }
      await command(1, "decide", decision(r.id));
    },
  );
  await check(
    "source ABA and expired review reject stale approval; extra expiry and missing fingerprint reject HTTP-shaped input",
    async () => {
      const f = await revision(),
        payload = await input(f),
        r = await command(0, "change", payload);
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=$1;",
        [f.m.id],
      );
      await owner.query("UPDATE memberships SET status='active' WHERE id=$1;", [
        f.m.id,
      ]);
      await deny(command(1, "decide", decision(r.id)));
      await command(1, "decide", decision(r.id, "rejected"));
      await deny(
        command(0, "change", {
          ...(await input(f)),
          validUntil: new Date(Date.now() + 86400000).toISOString(),
        }),
        400,
      );
      await deny(
        command(0, "change", { ...(await input(f)), definitionKey: undefined }),
        400,
      );
      const g = await revision(),
        p = await command(0, "change", {
          ...(await input(g)),
          expiresAt: new Date(Date.now() + 2500).toISOString(),
        });
      await new Promise((r) => setTimeout(r, 2600));
      await deny(command(1, "decide", decision(p.id)));
    },
  );
  await check(
    "beneficiaries cannot approve and non-delegable destination grants remain denied",
    async () => {
      const f = await revision();
      await owner.query("UPDATE memberships SET user_id=$1 WHERE id=$2", [
        access.accounts[2].memberId,
        f.m.id,
      ]);
      const r = await command(0, "change", await input(f));
      await deny(command(2, "decide", decision(r.id)), 403);
      await command(1, "decide", decision(r.id, "rejected"));
      const g = await revision(),
        bundle = randomUUID();
      await owner.query(
        "INSERT INTO permission_bundles(organization_id,id,version,status) VALUES($1,$2,1,'draft')",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO permission_grants VALUES($1,$2,1,'position.propose','unit')",
        [org, bundle],
      );
      await owner.query(
        "UPDATE permission_bundles SET status='approved' WHERE id=$1",
        [bundle],
      );
      await owner.query("UPDATE positions SET bundle_id=$1 WHERE id=$2", [
        bundle,
        g.dest,
      ]);
      assert.equal((await options(g)).items[0].blocker, "authority");
      await deny(command(0, "change", await input(g)));
    },
  );
  return { revision, input };
}
