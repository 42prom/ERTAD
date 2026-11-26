import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type request from "supertest";
import type { DemoAccess } from "../backend/src/localDemo";
import { unitCommand } from "../backend/src/modules/organization/units";
import { SecurityService } from "../backend/src/services/security";

type Session = {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  sessionId: string;
  sessionTokenHash: string;
};

export async function testUnitTerritories(owner: Client, access: DemoAccess, sessions: Session[]) {
  const org = access.organizationId;
  const region = access.accounts[2].unitId;
  let checks = 0;
  const check = async (name: string, run: () => Promise<void>) => {
    await run(); checks++; console.log("PASS " + name);
  };
  const command = (i: number, op: Parameters<typeof unitCommand>[1], input: object = {}) =>
    unitCommand(sessions[i], op, { organizationId: org, ...input });
  const denied = (promise: Promise<unknown>, status = 403) => assert.rejects(promise,
    (error: unknown) => (error as { statusCode?: number }).statusCode === status);
  const row = async (id: string) => (await owner.query("SELECT * FROM units WHERE organization_id=$1 AND id=$2", [org, id])).rows[0];
  const fresh = (parentId: string, operationalType: string, geographicAreaId: string) => ({
    key: randomUUID(), parentId, operationalType, geographicAreaId,
    name: "Synthetic territorial " + randomUUID().slice(0, 8),
    reason: "Synthetic territorial organization",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const decision = (id: string) => ({ id, key: randomUUID(), decision: "approved", reason: "Independent territorial review" });
  const admitUnit = async (parentId: string, type: string, area: string) => {
    const result = await command(2, "propose", fresh(parentId, type, area));
    return (await command(3, "decide", decision(result.id))).unitId as string;
  };
  const membersBefore = (await owner.query("SELECT count(*)::int n FROM memberships")).rows[0].n;
  await check("territorial catalogue is bounded, bilingual and isolated from organizational authority", async () => {
    const catalogue = await command(2, "geography");
    assert.equal(catalogue.items.length, 85);
    assert.equal(catalogue.items.filter((a: any) => a.kind === "district").length, 10);
    assert.equal(catalogue.items.filter((a: any) => a.kind === "municipality").length, 63);
    assert.equal(catalogue.additionalReferencesPending, true);
    assert.ok(catalogue.items.some((a: any) => a.id === "GE-AB"));
    assert.ok(catalogue.items.every((a: any) => a.nameKa && a.nameEn && !a.organizationId));
    assert.ok(catalogue.items.every((a: any) => a.parentId === null || catalogue.items.some((p: any) => p.id === a.parentId && p.kind === "region")));
    const response = await sessions[2].agent.get("/api/v1/admin/units/geography").query({ organizationId: org }).expect(200);
    assert.equal(response.body.version, catalogue.version);
    await denied(command(2, "geography", { organizationId: randomUUID() }));
    await sessions[2].agent.get("/api/v1/admin/units/geography").query({ organizationId: org, includeMembers: true }).expect(400);
  });
  const oldParent = await row(region);
  const legacy = await command(2, "propose", {
    key: randomUUID(), parentId: region, name: "Synthetic pending legacy mapping",
    reason: "Synthetic territorial drift test", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  await check("existing unit geography requires independent immutable review and preserves membership", async () => {
    const change = {
      kind: "territory", unitId: region, version: oldParent.version,
      operationalType: "region", geographicAreaId: "GE-TB", key: randomUUID(),
      reason: "Synthetic explicit mapping of existing unit",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const review = await command(0, "change", change);
    assert.equal((await row(region)).geographic_area_id, null);
    assert.deepEqual(await command(0, "change", change), review);
    await denied(command(0, "change", { ...change, geographicAreaId: "GE-IM" }), 409);
    await denied(command(0, "decide", decision(review.id)));
    await denied(command(4, "detail", { id: review.id }));
    await owner.query("SAVEPOINT unused").catch(() => {});
    await assert.rejects(owner.query("UPDATE unit_reviews SET geographic_area_id='GE-IM' WHERE id=$1", [review.id]));
    const detail = await command(1, "detail", { id: review.id });
    assert.equal(detail.geography.nameKa, "თბილისი");
    await command(1, "decide", decision(review.id));
    const mapped = await row(region);
    assert.equal(mapped.id, oldParent.id);
    assert.equal(mapped.name, oldParent.name);
    assert.equal(mapped.operational_type, "region");
    assert.equal(mapped.geographic_area_id, "GE-TB");
    assert.equal(mapped.version, oldParent.version + 1);
    assert.equal((await owner.query("SELECT count(*)::int n FROM memberships")).rows[0].n, membersBefore);
    await denied(command(3, "decide", decision(legacy.id)), 409);
    await denied(command(0, "change", { ...change, key: randomUUID(), version: mapped.version, geographicAreaId: "GE-IM" }), 409);
  });
  let district = "";
  await check("typed creation enforces territorial containment, current parent and independent approval", async () => {
    await denied(command(2, "propose", fresh(region, "group", "GE-TB-SABURTALO")), 400);
    await denied(command(2, "propose", fresh(region, "locality", "GE-IM-KUTAISI")), 400);
    const noType = fresh(region, "unclassified", "GE-TB");
    await denied(command(2, "propose", noType), 400);
    const proposal = fresh(region, "locality", "GE-TB-SABURTALO");
    const review = await command(2, "propose", proposal);
    await denied(command(2, "propose", { ...proposal, geographicAreaId: "GE-TB-VAKE" }), 409);
    await denied(command(2, "decide", decision(review.id)));
    await denied(command(4, "decide", decision(review.id)));
    const payload = decision(review.id);
    const results = await Promise.all([command(3, "decide", payload), command(3, "decide", payload)]);
    assert.equal(results[0].unitId, results[1].unitId);
    district = results[0].unitId;
    assert.equal((await row(district)).parent_id, region);
    const scoped = (await command(2, "units")).items.find((u: any) => u.id === district);
    assert.deepEqual(scoped.child_types, ["group"]);
    assert.equal(scoped.geography.nameKa, "საბურთალო");
    assert.ok(!(await command(4, "units")).items.some((u: any) => u.id === district));
  });
  await check("local groups and teams inherit the exact locality without new permissions and provision main group chat atomically", async () => {
    await denied(command(2, "propose", fresh(district, "group", "GE-TB-VAKE")), 400);
    const channelCountBefore = (await owner.query("SELECT count(*)::int n FROM ertad.channels")).rows[0].n;

    // 1. Approving region/locality creates 0 channels (district already approved above -> still 0 new channels)
    const teamProposal = fresh(await admitUnit(district, "group", "GE-TB-SABURTALO"), "team", "GE-TB-SABURTALO");
    const teamRev = await command(2, "propose", teamProposal);
    const teamDec = await command(3, "decide", decision(teamRev.id));
    assert.equal(teamDec.mainChannelId, null);

    // 2. Approving group atomically creates 1 is_main=true group channel, concurrent retries return identical ids, 0 memberships added
    const grpProp = fresh(district, "group", "GE-TB-SABURTALO");
    const grpRev = await command(2, "propose", grpProp);
    const decPayload = decision(grpRev.id);
    const [d1, d2] = await Promise.all([
      command(3, "decide", decPayload),
      command(3, "decide", decPayload),
    ]);
    assert.deepEqual(d1, d2);
    assert.ok(d1.unitId);
    assert.ok(d1.mainChannelId);
    const chRows = (await owner.query("SELECT * FROM ertad.channels WHERE organization_id=$1 AND unit_id=$2", [org, d1.unitId])).rows;
    assert.equal(chRows.length, 1);
    assert.equal(chRows[0].id, d1.mainChannelId);
    assert.equal(chRows[0].is_main, true);
    assert.equal(chRows[0].channel_kind, "group");
    assert.deepEqual(chRows[0].scope_path, (await owner.query("SELECT ertad.unit_path($1,$2) AS p", [org, d1.unitId])).rows[0].p);
    assert.equal((await owner.query("SELECT count(*)::int n FROM ertad.channels")).rows[0].n, channelCountBefore + 2);
    assert.equal((await owner.query("SELECT count(*)::int n FROM memberships")).rows[0].n, membersBefore);

    // 3. Team cannot have child teams and direct SQL cannot insert a second main channel or write channels from runtime role
    const grpTeam = await admitUnit(d1.unitId, "team", "GE-TB-SABURTALO");
    assert.equal((await row(grpTeam)).parent_id, d1.unitId);
    await denied(command(2, "propose", fresh(grpTeam, "team", "GE-TB-SABURTALO")), 400);
    await assert.rejects(
      owner.query(
        "INSERT INTO ertad.channels(organization_id,unit_id,scope_path,title,creator_id,channel_kind,is_main) VALUES($1,$2,$3,'Second main',$4,'group',true)",
        [org, d1.unitId, chRows[0].scope_path, access.accounts[3].memberId],
      ),
      (err: unknown) => (err as { code?: string }).code === "23505",
    );
    const { query } = await import("../backend/src/db/client");
    await assert.rejects(
      query(
        "INSERT INTO ertad.channels(organization_id,unit_id,scope_path,title,creator_id,channel_kind,is_main) VALUES($1,$2,$3,'Bypass main',$4,'group',true)",
        [org, d1.unitId, chRows[0].scope_path, access.accounts[3].memberId],
      ),
      (err: unknown) => (err as { code?: string }).code === "42501",
    );
  });
  await check("audit failure during group approval rolls back both unit and main channel", async () => {
    const grpProp = fresh(district, "group", "GE-TB-SABURTALO");
    const grpRev = await command(2, "propose", grpProp);
    const unitsBefore = (await owner.query("SELECT count(*)::int n FROM ertad.units")).rows[0].n;
    const channelsBefore = (await owner.query("SELECT count(*)::int n FROM ertad.channels")).rows[0].n;
    const original = SecurityService.logAuditEventInTransaction;
    SecurityService.logAuditEventInTransaction = async () => {
      throw new Error("Synthetic T2 audit failure");
    };
    try {
      await assert.rejects(command(3, "decide", decision(grpRev.id)), /Synthetic T2 audit failure/);
    } finally {
      SecurityService.logAuditEventInTransaction = original;
    }
    assert.equal((await owner.query("SELECT count(*)::int n FROM ertad.units")).rows[0].n, unitsBefore);
    assert.equal((await owner.query("SELECT count(*)::int n FROM ertad.channels")).rows[0].n, channelsBefore);
    assert.equal((await command(3, "detail", { id: grpRev.id })).status, "pending");
  });
  await check("territorial creation rolls back on audit failure and catalogue retirement", async () => {
    const original = SecurityService.logAuditEventInTransaction;
    const proposal = fresh(region, "locality", "GE-TB-VAKE");
    SecurityService.logAuditEventInTransaction = async () => { throw new Error("Synthetic territorial audit failure"); };
    try { await assert.rejects(command(2, "propose", proposal), /Synthetic territorial audit failure/); }
    finally { SecurityService.logAuditEventInTransaction = original; }
    assert.equal((await owner.query("SELECT count(*)::int n FROM unit_reviews WHERE request_key=$1", [proposal.key])).rows[0].n, 0);
    const review = await command(2, "propose", proposal);
    await owner.query("UPDATE geographic_areas SET active=false WHERE id='GE-TB-VAKE'");
    try { await denied(command(3, "decide", decision(review.id)), 400); }
    finally { await owner.query("UPDATE geographic_areas SET active=true WHERE id='GE-TB-VAKE'"); }
    assert.equal((await command(3, "detail", { id: review.id })).status, "pending");
  });
  await check("runtime cannot bypass catalogue or territorial validation with direct SQL", async () => {
    const { query } = await import("../backend/src/db/client");
    await assert.rejects(query("SELECT * FROM ertad.geographic_areas"));
    await assert.rejects(query("UPDATE ertad.geographic_areas SET active=false"));
    await assert.rejects(query("SELECT ertad.validate_unit_territory($1,$2,'region','GE-TB')", [org, region]));
    await assert.rejects(owner.query("UPDATE units SET geographic_area_id='GE-IM' WHERE id=$1", [region]));
  });
  return checks;
}
