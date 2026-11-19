import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile, link, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { Client } from "pg";
import { SecurityService } from "../backend/src/services/security";

/** Owner-only synthetic transport. No network request or credential return to an issuer. */
export async function deliverSyntheticInvitation(
  client: Client,
  id: string,
  directory: string,
  origin: string,
) {
  return deliverSyntheticCredential(
    client,
    id,
    directory,
    origin,
    "invitation",
  );
}
export async function deliverSyntheticCredential(
  client: Client,
  id: string,
  directory: string,
  origin: string,
  purpose: "invitation" | "recovery",
) {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? ""))
    throw new Error("Local synthetic mailbox only");
  const destination = new URL(origin);
  if (
    !["localhost", "127.0.0.1"].includes(destination.hostname) ||
    destination.protocol !== "http:" ||
    destination.origin !== origin
  )
    throw new Error("Loopback activation origin required");
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new Error("Invitation identifier required");
  const secret = randomBytes(32).toString("base64url"),
    digest = createHash("sha256").update(secret).digest("hex");
  const target = resolve(directory, id + ".json"),
    temporary = target + ".pending";
  await mkdir(directory, { recursive: true });
  let commitStarted = false,
    wroteTemporary = false;
  await client.query("BEGIN");
  try {
    const delivery = (
      await client.query(
        purpose === "recovery"
          ? "SELECT ertad.web_recovery_delivery($1,$2) result"
          : "SELECT ertad.web_invite_delivery($1,$2) result",
        [id, digest],
      )
    ).rows[0].result;
    await SecurityService.logAuditEventInTransaction(
      client,
      purpose === "recovery"
        ? "LOCAL_RECOVERY_DELIVERED"
        : "LOCAL_INVITATION_DELIVERED",
      purpose === "recovery"
        ? { recoveryId: id, synthetic: true }
        : { invitationId: id, synthetic: true },
    );
    const checked = (
      await client.query(
        purpose === "recovery"
          ? "SELECT ertad.web_recovery_consume($1,$2) result"
          : "SELECT ertad.web_invite_activate($1,$2) result",
        [id, digest],
      )
    ).rows[0].result;
    if (checked.email !== delivery.email)
      throw new Error("Delivery changed during audit");
    await writeFile(
      temporary,
      JSON.stringify(
        {
          synthetic: true,
          to: delivery.email,
          url: `${origin}/${purpose === "recovery" ? "recover" : "activate"}#${id}.${secret}`,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    wroteTemporary = true;
    commitStarted = true;
    await client.query("COMMIT");
    // Exclusive publication: a repeated run cannot overwrite a previous credential.
    await link(temporary, target);
    await unlink(temporary);
  } catch (error) {
    if (!commitStarted) {
      await client.query("ROLLBACK");
      if (wroteTemporary) await unlink(temporary).catch(() => {});
    }
    // An uncertain commit or publication leaves the private pending message intact.
    throw error;
  }
}
