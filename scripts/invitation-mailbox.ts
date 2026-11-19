import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import pg from "pg";
loadEnvFile(".env");
if (process.env.NODE_ENV && process.env.NODE_ENV !== "development")
  throw new Error("Local synthetic mailbox only");
process.env.NODE_ENV = "development";
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/ertad`;
const { deliverSyntheticCredential } = await import("./invitation-delivery");
const recovery = process.argv.includes("--recovery");
const directory = recovery
  ? ".local/recovery-mailbox"
  : ".local/invitation-mailbox";
const { close } = await import("../backend/src/db/client");
const client = new pg.Client({
  host: "127.0.0.1",
  port,
  database: "ertad",
  user: "ertad_owner",
  password: process.env.POSTGRES_PASSWORD,
  options: "-c search_path=ertad,public",
});
await client.connect();
try {
  const rows = (
    await client.query(
      recovery
        ? `SELECT id FROM web_account_recoveries WHERE token_hash IS NULL AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at LIMIT 25`
        : `SELECT i.id FROM web_invitations i JOIN web_invite_contacts c ON (c.organization_id,c.id)=(i.organization_id,i.contact_id)
 WHERE i.token_hash IS NULL AND i.revoked_at IS NULL AND i.consumed_at IS NULL AND c.source='synthetic'
 ORDER BY i.id LIMIT 25`,
    )
  ).rows;
  let count = 0,
    unavailable = 0;
  for (const row of rows) {
    try {
      await deliverSyntheticCredential(
        client,
        row.id,
        resolve(directory),
        `http://localhost:${process.env.ERTAD_WEB_PORT ?? 15173}`,
        recovery ? "recovery" : "invitation",
      );
      count++;
    } catch (error) {
      if ((error as { code?: string }).code === "P0409") {
        unavailable++;
        continue;
      }
      throw error;
    }
  }
  console.log(
    `Prepared ${count} synthetic messages; ${unavailable} unavailable requests skipped. Files: ${directory}. No external email sent; files are credentials.`,
  );
} catch (error) {
  console.error(
    "Local invitation delivery failed; inspect private pending messages before retrying.",
    { code: (error as { code?: string }).code },
  );
  process.exitCode = 1;
} finally {
  await client.end();
  await close();
}
