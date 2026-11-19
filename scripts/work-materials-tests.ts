import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { testWorkOversight } from "./work-oversight-tests";
import { SecurityService } from "../backend/src/services/security";

export async function testWorkMaterials({
  command,
  act,
  detail,
  owner,
  access,
  check,
  denied,
}: Parameters<typeof testWorkOversight>[0]) {
  const org = access.organizationId,
    region = access.accounts[2].unitId;
  const task = await command(2, "create", {
    key: randomUUID(),
    unitId: region,
    title: "Synthetic materials task",
    description: "Shared instructions",
    roleLabel: "Participant",
    capacity: 2,
    priority: "normal",
    deadline: new Date(Date.now() + 3600000).toISOString(),
    contributionRuleId: null,
  });
  const links = [
    {
      title: "Meeting instructions",
      url: "https://example.org/instructions?day=1#meeting",
    },
  ];
  let saved: any;
  await check(
    "materials follow task scope and exclude content from lists, history and retry receipts",
    async () => {
      await denied(act(4, "materials", task.id, { links }));
      saved = await act(2, "materials", task.id, { links });
      assert.deepEqual((await detail(3, task.id)).materialLinks, links);
      assert.deepEqual((await detail(0, task.id)).materialLinks, links);
      await denied(
        command(2, "detail", { organizationId: randomUUID(), id: task.id }),
      );
      assert.ok(
        !JSON.stringify(await command(2, "list")).includes("example.org"),
      );
      assert.ok(
        !JSON.stringify((await detail(2, task.id)).events).includes(
          "example.org",
        ),
      );
      const receipts = await owner.query(
        "SELECT payload FROM work_commands WHERE organization_id=$1 AND work_id=$2 AND operation='materials'",
        [org, task.id],
      );
      assert.ok(!JSON.stringify(receipts.rows).includes("example.org"));
    },
  );
  await check(
    "materials reject executable, credentialed, malformed and oversized link payloads",
    async () => {
      for (const url of [
        "javascript:alert(1)",
        "data:text/html,test",
        "file:///etc/passwd",
        "//example.org",
        "https://user:secret@example.org",
        "https://example.org\\evil",
        "https://example.org\n",
        "https://",
        "https://example.org/" + "x".repeat(2048),
      ]) {
        await denied(
          act(2, "materials", task.id, { links: [{ title: "Invalid", url }] }),
          400,
        );
      }
      await denied(
        act(2, "materials", task.id, { links: Array(11).fill(links[0]) }),
        400,
      );
      await denied(
        act(2, "materials", task.id, {
          links: [{ ...links[0], html: "unsafe" }],
        }),
        400,
      );
      assert.equal((await detail(2, task.id)).version, saved.version);
      const invalid = await owner.query(
        "SELECT ertad.work_material_links_valid($1::jsonb) AS valid",
        [JSON.stringify([{ title: "unsafe", url: "javascript:alert(1)" }])],
      );
      assert.equal(invalid.rows[0].valid, false);
    },
  );
  await check(
    "concurrent material retries change once and stale or changed payloads conflict",
    async () => {
      const input = {
        id: task.id,
        key: randomUUID(),
        version: saved.version,
        links: [
          { title: "Updated instructions", url: "https://example.org/updated" },
        ],
      };
      const [a, b] = await Promise.all([
        command(2, "materials", input),
        command(2, "materials", input),
      ]);
      assert.deepEqual(a, b);
      assert.equal(a.version, saved.version + 1);
      await denied(command(2, "materials", { ...input, links: [] }), 409);
      await denied(
        command(2, "materials", { ...input, key: randomUUID() }),
        409,
      );
    },
  );
  await check(
    "required audit failures roll back materials, version and receipts",
    async () => {
      const before = await detail(2, task.id),
        key = randomUUID();
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("Synthetic materials audit outage");
      };
      try {
        await assert.rejects(
          command(2, "materials", {
            id: task.id,
            key,
            version: before.version,
            links: [],
          }),
        );
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      assert.deepEqual(
        (await detail(2, task.id)).materialLinks,
        before.materialLinks,
      );
      assert.equal((await detail(2, task.id)).version, before.version);
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
    "expired authority and moved hierarchy cannot read or edit task materials",
    async () => {
      const memberships = (
        await owner.query(
          "SELECT id,valid_from,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [org, access.accounts[3].memberId],
        )
      ).rows;
      await owner.query(
        "UPDATE memberships SET valid_until=clock_timestamp()-interval '1 second',valid_from=clock_timestamp()-interval '2 days' WHERE organization_id=$1 AND user_id=$2 AND status='active'",
        [org, access.accounts[3].memberId],
      );
      try {
        await denied(detail(3, task.id));
        await denied(
          command(3, "materials", {
            id: task.id,
            key: randomUUID(),
            version: 1,
            links: [],
          }),
        );
      } finally {
        for (const m of memberships)
          await owner.query(
            "UPDATE memberships SET valid_until=$2,valid_from=$3 WHERE id=$1",
            [m.id, m.valid_until, m.valid_from],
          );
      }
      const oldParent = (
        await owner.query(
          "SELECT parent_id FROM units WHERE organization_id=$1 AND id=$2",
          [org, region],
        )
      ).rows[0].parent_id;
      await owner.query(
        "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
        [org, region, access.accounts[4].unitId],
      );
      try {
        await denied(detail(2, task.id));
      } finally {
        await owner.query(
          "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
          [org, region, oldParent],
        );
      }
    },
  );
  await check(
    "task readers can view shared links but cannot replace them",
    async () => {
      const bundle = randomUUID(),
        position = randomUUID(),
        member = access.accounts[3].memberId;
      const original = (
        await owner.query(
          "SELECT m.id,m.valid_from,m.valid_until FROM memberships m JOIN positions p ON p.organization_id=m.organization_id AND p.id=m.position_id WHERE m.organization_id=$1 AND m.user_id=$2 AND p.bundle_id=$3",
          [org, member, "4be38062-e4e7-4c30-a17d-fcb0a305a611"],
        )
      ).rows;
      await owner.query(
        "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO permission_grants VALUES($1,$2,1,'workitem.read','subtree')",
        [org, bundle],
      );
      await owner.query(
        "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
        [org, bundle],
      );
      await owner.query(
        "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic materials reader',$4,1)",
        [org, position, region, bundle],
      );
      await owner.query(
        "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')",
        [org, member, region, position],
      );
      try {
        for (const m of original)
          await owner.query(
            "UPDATE memberships SET valid_from=now()-interval '2 days',valid_until=now()-interval '1 day' WHERE id=$1",
            [m.id],
          );
        const view = await detail(3, task.id);
        assert.equal(view.canManage, false);
        assert.ok(view.materialLinks.length > 0);
        await denied(
          command(3, "materials", {
            id: task.id,
            key: randomUUID(),
            version: view.version,
            links: [],
          }),
        );
      } finally {
        for (const m of original)
          await owner.query(
            "UPDATE memberships SET valid_from=$2,valid_until=$3 WHERE id=$1",
            [m.id, m.valid_from, m.valid_until],
          );
      }
    },
  );
  await check(
    "removal clears shared links without activity, closed tasks reject edits but retain exact receipts",
    async () => {
      const before = (
        await owner.query(
          "SELECT count(*)::int n FROM activity_entries WHERE organization_id=$1",
          [org],
        )
      ).rows[0].n;
      const input = {
        id: task.id,
        key: randomUUID(),
        version: (await detail(2, task.id)).version,
        links: [],
      };
      const cleared = await command(2, "materials", input);
      assert.deepEqual((await detail(3, task.id)).materialLinks, []);
      await act(2, "cancel", task.id, { note: "Synthetic task closed" });
      await denied(act(2, "materials", task.id, { links }), 409);
      assert.deepEqual(await command(2, "materials", input), cleared);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM activity_entries WHERE organization_id=$1",
            [org],
          )
        ).rows[0].n,
        before,
      );
    },
  );
}
