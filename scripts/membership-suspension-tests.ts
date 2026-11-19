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
export async function testMembershipSuspension({
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
    a = access.accounts[2].unitId,
    b = access.accounts[4].unitId;
  const denied = (p: Promise<unknown>, code = 409) =>
    assert.rejects(
      p,
      (e: unknown) => (e as { statusCode: number }).statusCode === code,
    );
  const row = async (f: Fixture) =>
    (await owner.query("SELECT * FROM memberships WHERE id=$1", [f.m.id]))
      .rows[0];
  const input = async (f: Fixture, kind = "suspend") => ({
    membershipId: f.m.id,
    version: (await row(f)).version,
    kind,
    key: randomUUID(),
    reason: "Synthetic reviewed membership restriction",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const decision = (id: string, choice = "approved") => ({
    id,
    key: randomUUID(),
    decision: choice,
    reason: "Synthetic independent membership review",
  });
  const has = async (user: string, unit: string) =>
    (
      await owner.query(
        "SELECT ertad.review_has_scope($1,$2,$3,'unit.read') ok",
        [user, org, unit],
      )
    ).rows[0].ok;
  async function apply(f: Fixture, kind = "suspend") {
    const p = await command(0, "change", await input(f, kind));
    await command(1, "decide", decision(p.id));
    return p;
  }
  async function history() {
    const result = [];
    for (const table of [
      "work_assignments",
      "activity_entries",
      "contribution_entries",
    ])
      result.push(
        (
          await owner.query(
            "SELECT to_jsonb(t) data FROM " +
              table +
              " t ORDER BY to_jsonb(t)::text",
          )
        ).rows,
      );
    return result;
  }
  await check(
    "suspension removes only selected authority; restoration preserves expiry, assignments, Activity and points",
    async () => {
      const f = await fixture();
      await work(f);
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from) VALUES($1,$2,$3,$4,1,now())",
        [org, f.user, b, f.dest],
      );
      const before = await row(f),
        records = await history(),
        request = await input(f);
      await denied(command(4, "change", request), 403);
      const p = await command(2, "change", request);
      await denied(command(2, "decide", decision(p.id)), 403);
      const detail = await command(3, "detail", { id: p.id });
      assert.equal(detail.kind, "suspend");
      assert.equal(detail.source_snapshot, undefined);
      assert.equal(
        Date.parse(detail.sourceValidUntil),
        before.valid_until.getTime(),
      );
      const d = decision(p.id),
        [first, second] = await Promise.all([
          command(3, "decide", d),
          command(3, "decide", d),
        ]);
      assert.deepEqual(first, second);
      assert.equal(await has(f.user, a), false);
      assert.equal(await has(f.user, b), true);
      assert.deepEqual(await row(f), {
        ...before,
        status: "suspended",
        version: 1,
      });
      const opts = await command(2, "changeOptions", { membershipId: f.m.id });
      assert.equal(opts.canResume, true);
      assert.equal(opts.canSuspend, false);
      assert.equal(opts.blocked, true);
      assert.equal(opts.canRevoke, false);
      const member = (
        await owner.query("SELECT ertad.member_summary($1,$2,$3,NULL) data", [
          access.accounts[0].memberId,
          org,
          f.user,
        ])
      ).rows[0].data;
      assert.equal(
        member.memberships.find((m: { id: string }) => m.id === f.m.id)
          .canChange,
        true,
      );
      await apply(f, "resume");
      assert.equal(await has(f.user, a), true);
      assert.deepEqual(await row(f), { ...before, version: 2 });
      assert.deepEqual(await history(), records);
      assert.deepEqual(await command(2, "change", request), {
        ...p,
        status: "approved",
      });
    },
  );
  await check(
    "self changes, subject approval, competing requests and changed retry payloads are denied",
    async () => {
      const self = await fixture();
      await owner.query("UPDATE memberships SET user_id=$1 WHERE id=$2", [
        access.accounts[2].memberId,
        self.m.id,
      ]);
      await denied(command(2, "change", await input(self)), 403);
      const own = await command(0, "change", await input(self));
      await denied(command(2, "decide", decision(own.id)), 403);
      await command(1, "decide", decision(own.id, "rejected"));
      const f = await fixture(),
        body = await input(f),
        p = await command(0, "change", body),
        q = await command(2, "change", { ...body, key: randomUUID() });
      await denied(command(0, "change", { ...body, kind: "resume" }));
      await command(1, "decide", decision(p.id));
      await denied(command(3, "decide", decision(q.id)));
      await command(3, "decide", decision(q.id, "rejected"));
      assert.equal((await row(f)).version, 1);
    },
  );
  await check(
    "scheduled memberships stay scheduled after resumption; expired and ended authority cannot return",
    async () => {
      const f = await fixture();
      await owner.query(
        "UPDATE memberships SET valid_from=now()+interval '1 day' WHERE id=$1",
        [f.m.id],
      );
      const before = await row(f);
      assert.equal(await has(f.user, a), false);
      await apply(f);
      await apply(f, "resume");
      assert.deepEqual(await row(f), {
        ...before,
        version: before.version + 2,
      });
      assert.equal(await has(f.user, a), false);
      const g = await fixture();
      await apply(g);
      await apply(g, "revoke");
      assert.equal((await row(g)).status, "ended");
      await denied(command(0, "change", await input(g, "resume")));
      const h = await fixture();
      await apply(h);
      await owner.query(
        "UPDATE memberships SET valid_until=now()-interval '1 second' WHERE id=$1",
        [h.m.id],
      );
      await denied(command(0, "change", await input(h, "resume")));
      assert.equal(
        (await command(0, "changeOptions", { membershipId: h.m.id })).canResume,
        false,
      );
    },
  );
  await check(
    "retired definitions, changed bundles and overlapping active memberships prevent restoration",
    async () => {
      const f = await fixture();
      await apply(f);
      await owner.query("UPDATE positions SET status='retired' WHERE id=$1", [
        f.source,
      ]);
      await denied(command(0, "change", await input(f, "resume")));
      assert.equal(
        (await command(0, "changeOptions", { membershipId: f.m.id })).canResume,
        false,
      );
      const g = await fixture();
      await apply(g);
      const restore = await command(0, "change", await input(g, "resume"));
      await owner.query(
        "UPDATE positions SET bundle_id=(SELECT id FROM permission_bundles WHERE organization_id=$1 AND id<>positions.bundle_id AND version=1 LIMIT 1) WHERE id=$2",
        [org, g.source],
      );
      await denied(command(1, "decide", decision(restore.id)));
      await command(1, "decide", decision(restore.id, "rejected"));
      const h = await fixture();
      await apply(h);
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from) VALUES($1,$2,$3,$4,1,now())",
        [org, h.user, a, h.source],
      );
      await denied(command(0, "change", await input(h, "resume")));
    },
  );
  await check(
    "stale source and expired request deny approval while rejection stays available after source drift",
    async () => {
      const f = await fixture(),
        p = await command(0, "change", await input(f));
      await owner.query(
        "UPDATE memberships SET status='suspended' WHERE id=$1",
        [f.m.id],
      );
      await owner.query("UPDATE memberships SET status='active' WHERE id=$1", [
        f.m.id,
      ]);
      await denied(command(1, "decide", decision(p.id)));
      await command(1, "decide", decision(p.id, "rejected"));
      const g = await fixture(),
        q = await command(0, "change", {...await input(g),expiresAt:new Date(Date.now()+3000).toISOString()});
      await new Promise(resolve=>setTimeout(resolve,3100));
      await denied(command(1, "decide", decision(q.id)));
      assert.equal((await row(g)).status, "active");
    },
  );
  await check(
    "audit outage and source tampering roll back suspension, status, receipt and notifications",
    async () => {
      const f = await fixture(),
        p = await command(0, "change", await input(f)),
        before = await row(f);
      await owner.query(
        "CREATE FUNCTION pause_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='MEMBERSHIP_REVIEW' THEN RAISE EXCEPTION 'Synthetic pause audit outage'; END IF; RETURN NEW; END $$; CREATE TRIGGER pause_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION pause_audit_fail()",
      );
      try {
        await assert.rejects(command(1, "decide", decision(p.id)));
      } finally {
        await owner.query(
          "DROP TRIGGER pause_audit_fail ON audit_log; DROP FUNCTION pause_audit_fail()",
        );
      }
      await owner.query(
        `CREATE FUNCTION pause_audit_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='MEMBERSHIP_REVIEW' THEN UPDATE ertad.memberships SET valid_until=valid_until+interval '1 day' WHERE id='${f.m.id}'; END IF; RETURN NEW; END $$; CREATE TRIGGER pause_audit_tamper AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION pause_audit_tamper()`,
      );
      try {
        await denied(command(1, "decide", decision(p.id)));
      } finally {
        await owner.query(
          "DROP TRIGGER pause_audit_tamper ON audit_log; DROP FUNCTION pause_audit_tamper()",
        );
      }
      assert.deepEqual(await row(f), before);
      assert.equal(
        (
          await owner.query(
            "SELECT status FROM membership_reviews WHERE id=$1",
            [p.id],
          )
        ).rows[0].status,
        "pending",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM review_notifications WHERE review_id=$1",
            [p.id],
          )
        ).rows[0].n,
        0,
      );
      await command(1, "decide", decision(p.id));
    },
  );
  await check(
    "post-audit definition retirement and proposer revocation roll back restoration",
    async () => {
      const f = await fixture();
      await apply(f);
      const p = await command(0, "change", await input(f, "resume"));
      await owner.query(
        `CREATE FUNCTION pause_definition_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='MEMBERSHIP_REVIEW' THEN UPDATE ertad.positions SET status='retired' WHERE id='${f.source}'; END IF; RETURN NEW; END $$; CREATE TRIGGER pause_definition_tamper AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION pause_definition_tamper()`,
      );
      try {
        await denied(command(1, "decide", decision(p.id)));
      } finally {
        await owner.query(
          "DROP TRIGGER pause_definition_tamper ON audit_log; DROP FUNCTION pause_definition_tamper()",
        );
      }
      await owner.query(
        `CREATE FUNCTION pause_authority_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN IF NEW.event_type='MEMBERSHIP_REVIEW' THEN UPDATE ertad.memberships SET status='suspended' WHERE user_id='${access.accounts[0].memberId}'; END IF; RETURN NEW; END $$; CREATE TRIGGER pause_authority_tamper AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION pause_authority_tamper()`,
      );
      try {
        await denied(command(1, "decide", decision(p.id)));
      } finally {
        await owner.query(
          "DROP TRIGGER pause_authority_tamper ON audit_log; DROP FUNCTION pause_authority_tamper()",
        );
      }
      assert.equal((await row(f)).status, "suspended");
      await command(1, "decide", decision(p.id));
      assert.equal((await row(f)).status, "active");
    },
  );
}
