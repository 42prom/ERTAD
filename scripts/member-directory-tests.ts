import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { memberDirectoryCommand } from "../backend/src/modules/organization/members";
import { enableDemoMembers } from "./web-demo-members";
import { SecurityService } from "../backend/src/services/security";

export async function testMemberDirectory({
  command,
  collective,
  act,
  app,
  owner,
  access,
  check,
  denied,
  sessions,
}: any) {
  const org = access.organizationId,
    region = access.accounts[2].unitId,
    root = access.accounts[0].unitId;
  const member = (i: number) => access.accounts[i].memberId;
  const read = (
    i: number,
    op: Parameters<typeof memberDirectoryCommand>[1],
    input: object = {},
  ) =>
    memberDirectoryCommand(
      sessions[i],
      op,
      op === "contexts" ? {} : { organizationId: org, ...input },
    );
  await check(
    "directory is denied without an explicit scoped grant, including accounts labelled superadmin",
    async () => {
      assert.deepEqual(await read(0, "contexts"), []);
      await denied(read(0, "list"));
      await owner.query("BEGIN");
      await enableDemoMembers(owner, access);
      await owner.query("COMMIT");
      assert.equal((await read(0, "contexts")).length, 1);
    },
  );
  await check(
    "council and region discovery, counts, names, exact codes and filters share the same scope",
    async () => {
      assert.equal((await read(0, "list")).total, 6);
      const a = await read(2, "list");
      assert.equal(a.total, 2);
      assert.deepEqual(
        a.items.map((m: any) => m.id).sort(),
        [member(2), member(3)].sort(),
      );
      assert.equal(
        (await read(2, "list", { search: access.accounts[3].label })).total,
        1,
      );
      assert.equal(
        (await read(2, "list", { search: member(3).toUpperCase() })).total,
        1,
      );
      assert.equal(
        (await read(2, "list", { search: member(3).slice(0, 8) })).total,
        0,
      );
      assert.equal(
        (await read(2, "list", { search: access.accounts[4].label })).total,
        0,
      );
      assert.equal(
        (await read(2, "list", { search: access.accounts[3].email })).total,
        0,
      );
      assert.equal((await read(0, "list", { unitId: region })).total, 2);
      assert.equal(
        (await read(2, "list", { role: "nonexistent role" })).total,
        0,
      );
      await denied(read(2, "list", { unitId: root }));
      await denied(read(2, "detail", { memberId: member(4) }));
      await denied(read(2, "list", { organizationId: randomUUID() }));
      const units = await read(2, "units");
      assert.ok(
        !units.items.some(
          (u: any) => u.id === root || u.id === access.accounts[4].unitId,
        ),
      );
      const serialized = JSON.stringify(
        await read(2, "detail", { memberId: member(3) }),
      );
      for (const secret of [
        "password",
        "email",
        "webAccount",
        "mfa",
        "lastLogin",
        "biometric",
      ])
        assert.ok(!serialized.includes(secret));
    },
  );
  await check(
    "membership state filters reflect expiry, future start and suspension without duplicating people",
    async () => {
      const position = (
        await owner.query(
          "SELECT position_id FROM memberships WHERE organization_id=$1 AND user_id=$2 LIMIT 1",
          [org, member(3)],
        )
      ).rows[0].position_id;
      const ids: string[] = [];
      for (const [state, from, until] of [
        ["active", "-2 days", "-1 day"],
        ["active", "1 day", "2 days"],
        ["suspended", "-1 day", "2 days"],
      ]) {
        const id = randomUUID();
        ids.push(id);
        await owner.query(
          "INSERT INTO memberships(organization_id,id,user_id,unit_id,position_id,bundle_version,status,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,1,$6,now()+$7::interval,now()+$8::interval)",
          [org, id, member(3), region, position, state, from, until],
        );
      }
      try {
        for (const status of ["expired", "scheduled", "suspended"])
          assert.equal((await read(2, "list", { status })).total, 1);
        assert.equal((await read(2, "list", { status: "all" })).total, 2);
      } finally {
        await owner.query(
          "DELETE FROM memberships WHERE organization_id=$1 AND id=ANY($2::uuid[])",
          [org, ids],
        );
      }
    },
  );
  await check(
    "task participation and actual awarded points reuse independent source permissions",
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
        reason: "Synthetic directory reward",
        deadline: new Date(Date.now() + 86400000).toISOString(),
      });
      await collective(1, "vote", {
        key: randomUUID(),
        id: proposal.id,
        version: (await collective(1, "detail", { id: proposal.id })).version,
        choice: "approve",
        reason: "Independent synthetic approval",
      });
      const rule = (await collective(0, "points")).rules.find(
        (r: any) => r.category === "task",
      ).id;
      const work = await command(2, "create", {
        key: randomUUID(),
        unitId: region,
        title: "Synthetic directory task",
        roleLabel: "Participant",
        priority: "normal",
        capacity: 2,
        deadline: new Date(Date.now() + 86400000).toISOString(),
        contributionRuleId: rule,
      });
      await act(3, "apply", work.id);
      await act(2, "assign", work.id, { memberId: member(3) });
      await act(3, "start", work.id);
      await act(3, "submit", work.id);
      await act(0, "verify", work.id, { memberId: member(3) });
      const d = await read(2, "detail", { memberId: member(3) });
      assert.equal(d.points, "17");
      assert.equal(d.work.verified, 1);
      assert.equal(d.work.items[0].id, work.id);
      assert.ok(d.pointsScopes.some((s: any) => s.id === region));
      const owned = (
        await owner.query(
          "SELECT id,valid_until,valid_from FROM memberships WHERE organization_id=$1 AND user_id=$2",
          [org, member(2)],
        )
      ).rows;
      const bundle = randomUUID(),
        position = randomUUID();
      await owner.query(
        "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
        [org, bundle],
      );
      for (const permission of ["member.read", "unit.read"])
        await owner.query(
          "INSERT INTO permission_grants VALUES($1,$2,1,$3,'subtree')",
          [org, bundle, permission],
        );
      await owner.query(
        "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic directory-only reader',$4,1)",
        [org, position, region, bundle],
      );
      const membership = randomUUID();
      await owner.query(
        "INSERT INTO memberships(organization_id,id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,1,now()-interval '1 minute',now()+interval '1 day')",
        [org, membership, member(2), region, position],
      );
      try {
        await owner.query(
          "UPDATE memberships SET valid_from=now()-interval '2 days',valid_until=now()-interval '1 day' WHERE id=ANY($1::uuid[])",
          [owned.map((m: any) => m.id)],
        );
        const restricted = await read(2, "detail", { memberId: member(3) });
        assert.equal(restricted.points, null);
        assert.equal(restricted.work.total, 0);
        assert.deepEqual(restricted.pointsScopes, []);
        assert.equal(restricted.canPropose, false);
      } finally {
        for (const m of owned)
          await owner.query(
            "UPDATE memberships SET valid_from=$2,valid_until=$3 WHERE id=$1",
            [m.id, m.valid_from, m.valid_until],
          );
        await owner.query("DELETE FROM memberships WHERE id=$1", [membership]);
      }
    },
  );
  await check(
    "filtered pagination is stable, unique and does not include a sibling region",
    async () => {
      const position = (
        await owner.query(
          "SELECT position_id FROM memberships WHERE organization_id=$1 AND user_id=$2 LIMIT 1",
          [org, member(3)],
        )
      ).rows[0].position_id;
      for (let i = 0; i < 28; i++) {
        const id = randomUUID();
        await owner.query("INSERT INTO member_users(id) VALUES($1)", [id]);
        await owner.query(
          "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
          [org, id, region, position],
        );
        await owner.query(
          "INSERT INTO organization_member_labels VALUES($1,$2,$3)",
          [org, id, "Synthetic page member " + String(i).padStart(2, "0")],
        );
      }
      const first = await read(2, "list", { search: "Synthetic page member" }),
        second = await read(2, "list", {
          search: "Synthetic page member",
          page: 2,
        });
      assert.equal(first.total, 28);
      assert.equal(first.items.length, 25);
      assert.equal(second.items.length, 3);
      assert.equal(
        new Set([...first.items, ...second.items].map((m) => m.id)).size,
        28,
      );
      assert.deepEqual(
        await read(2, "list", { search: "Synthetic page member" }),
        first,
      );
      assert.equal(
        (await read(4, "list", { search: "Synthetic page member" })).total,
        0,
      );
    },
  );
  await check(
    "required audit failure and authority expiry after the first read never disclose a successful response",
    async () => {
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic directory audit outage");
      };
      try {
        await assert.rejects(read(2, "list"));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      const grants = (
        await owner.query(
          "SELECT id,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, member(2)],
        )
      ).rows;
      let reached = false;
      try {
        const expires = (
          await owner.query(
            "UPDATE memberships SET valid_until=clock_timestamp()+interval '8 seconds' WHERE id=ANY($1::uuid[]) RETURNING valid_until",
            [grants.map((g: any) => g.id)],
          )
        ).rows[0].valid_until;
        SecurityService.logAuditEventInTransaction = async (
          client,
          ...rest
        ) => {
          assert.equal(rest[0], "MEMBER_DIRECTORY_READ");
          reached = true;
          await original.call(SecurityService, client, ...rest);
          await client.query(
            "SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.1)",
            [expires],
          );
        };
        await denied(read(2, "detail", { memberId: member(3) }));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        for (const g of grants)
          await owner.query(
            "UPDATE memberships SET valid_until=$2 WHERE id=$1",
            [g.id, g.valid_until],
          );
      }
      assert.equal(reached, true);
    },
  );
  await check(
    "directory HTTP is authenticated, bounded, strict and not cacheable",
    async () => {
      await request(app)
        .get("/api/v1/admin/members/list")
        .query({ organizationId: org })
        .expect(401);
      await sessions[2].agent
        .get("/api/v1/admin/members/list")
        .query({ organizationId: org, page: 0 })
        .expect(400);
      await sessions[2].agent
        .get("/api/v1/admin/members/list")
        .query({ organizationId: org, includePrivate: true })
        .expect(400);
      await sessions[2].agent
        .get("/api/v1/admin/members/list")
        .query({ organizationId: org, search: "x".repeat(121) })
        .expect(400);
      await sessions[2].agent
        .get("/api/v1/admin/members/detail")
        .query({ organizationId: org, memberId: member(4) })
        .expect(403);
      await sessions[2].agent
        .get("/api/v1/admin/members/list")
        .query({ organizationId: org })
        .expect("Cache-Control", "no-store")
        .expect(200);
      const data = (
        await owner.query(
          "SELECT payload FROM audit_log WHERE event_type='MEMBER_DIRECTORY_READ'",
        )
      ).rows;
      assert.ok(!JSON.stringify(data).includes("Synthetic page member"));
    },
  );
  await check(
    "group-only grants exclude parent and sibling membership; moved units change current scope",
    async () => {
      const group = (
        await owner.query(
          "SELECT id FROM units WHERE organization_id=$1 AND parent_id=$2 LIMIT 1",
          [org, region],
        )
      ).rows[0].id;
      const original = (
        await owner.query(
          "SELECT id,valid_from,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2",
          [org, member(2)],
        )
      ).rows;
      const bundle = randomUUID(),
        position = randomUUID(),
        membership = randomUUID(),
        groupMember = randomUUID();
      await owner.query(
        "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
        [org, bundle],
      );
      for (const permission of ["member.read", "unit.read"])
        await owner.query(
          "INSERT INTO permission_grants VALUES($1,$2,1,$3,'unit')",
          [org, bundle, permission],
        );
      await owner.query(
        "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic group reader',$4,1)",
        [org, position, group, bundle],
      );
      await owner.query("INSERT INTO member_users(id) VALUES($1)", [
        groupMember,
      ]);
      await owner.query(
        "INSERT INTO organization_member_labels VALUES($1,$2,$3)",
        [org, groupMember, "Synthetic group member"],
      );
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
        [org, groupMember, group, position],
      );
      await owner.query(
        "INSERT INTO memberships(organization_id,id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,1,now(),now()+interval '1 day')",
        [org, membership, member(2), group, position],
      );
      try {
        await owner.query(
          "UPDATE memberships SET valid_from=now()-interval '2 days',valid_until=now()-interval '1 day' WHERE id=ANY($1::uuid[])",
          [original.map((m: any) => m.id)],
        );
        const list = await read(2, "list");
        assert.equal(list.total, 2);
        assert.equal(
          list.items.find((m: any) => m.id === member(2)).memberships.length,
          1,
        );
        await denied(read(2, "detail", { memberId: member(3) }));
        await denied(read(2, "list", { unitId: region }));
      } finally {
        for (const m of original)
          await owner.query(
            "UPDATE memberships SET valid_from=$2,valid_until=$3 WHERE id=$1",
            [m.id, m.valid_from, m.valid_until],
          );
        await owner.query("DELETE FROM memberships WHERE id=$1", [membership]);
      }
      try {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, group, access.accounts[4].unitId],
        );
        await denied(read(2, "detail", { memberId: groupMember }));
        assert.equal(
          (await read(4, "list", { search: "Synthetic group member" })).total,
          1,
        );
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, group, region],
        );
      }
    },
  );
}
