import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import type { EvidenceStore } from "../backend/src/modules/work/evidence";

/** Deletes only expired ERTAD evidence objects; durable pending rows cover failed publications. */
export async function purgeWorkEvidence(
  client: pg.Client,
  store: EvidenceStore,
  limit = 25,
) {
  const { evidenceObjectKey } = await import("../backend/src/modules/work/evidence");
  const { SecurityService } = await import("../backend/src/services/security");
  let removed = 0;
  for (let n = 0; n < Math.min(limit, 100); n++) {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT pg_advisory_xact_lock(752991884322001::bigint)",
      );
      const row = (
        await client.query(
          "SELECT organization_id,id,kind FROM ertad.work_evidence WHERE state<>'purged' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 1 FOR UPDATE",
        )
      ).rows[0];
      if (!row) {
        await client.query("COMMIT");
        break;
      }
      await store.delete(evidenceObjectKey(row.organization_id, row.id, row.kind));
      await client.query(
        "UPDATE ertad.work_evidence SET state='purged' WHERE organization_id=$1 AND id=$2",
        [row.organization_id, row.id],
      );
      await SecurityService.logAuditEventInTransaction(
        client,
        "WORK_EVIDENCE_PURGED",
        { organizationId: row.organization_id, evidenceId: row.id },
      );
      await client.query("COMMIT");
      removed++;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return removed;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  loadEnvFile(".env");
  if (!["development", "test"].includes(process.env.NODE_ENV ?? "development"))
    throw new Error("Local cleanup only");
  process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${process.env.ERTAD_POSTGRES_PORT ?? 15432}/ertad`;
  const { createEvidenceStore } = await import("../backend/src/modules/work/evidence");
  const client = new pg.Client({
    host: "127.0.0.1",
    port: Number(process.env.ERTAD_POSTGRES_PORT ?? 15432),
    database: "ertad",
    user: "ertad_owner",
    password: process.env.POSTGRES_PASSWORD,
  });
  await client.connect();
  try {
    console.log(
      `Purged ${await purgeWorkEvidence(client, createEvidenceStore())} expired evidence objects`,
    );
  } finally {
    await client.end();
  }
}
