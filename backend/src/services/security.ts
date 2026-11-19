import crypto from 'crypto';
import { transaction } from '../db/client';

/**
 * Shared append-only audit writer. Strict operations propagate storage failures.
 */
export class SecurityService {

  /**
   * Write an immutable, chained-hash audit log entry (standalone — uses pool directly).
   * Failures are swallowed so the caller never crashes.
   */
  static async logAuditEvent(eventType: string, payload: any): Promise<void> {
    try {
      await transaction(async client => {
        await SecurityService._writeAuditEntry(client, eventType, payload);
      });
    } catch (err) {
      console.error('[Security] Failed to write audit log:', err);
    }
  }

  /**
   * Append an audit event and propagate any storage failure. Control-plane
   * mutations call this before execution so an action cannot proceed when the
   * audit ledger is unavailable.
   */
  static async logAuditEventStrict(eventType: string, payload: any): Promise<void> {
    await transaction(async client => {
      await SecurityService._writeAuditEntry(client, eventType, payload);
    });
  }

  /**
   * Write an immutable audit log entry INSIDE an existing DB transaction.
   *
   * Use this when you need the audit write to be atomic with a surrounding
   * transaction (e.g., session creation). If the transaction rolls back, the
   * audit entry is automatically discarded.
   *
   * @param client    - Active PoolClient from pool.connect()
   * @param eventType - Category string for the audit event
   * @param payload   - Arbitrary JSON-serializable details
   */
  static async logAuditEventInTransaction(
    client: any,
    eventType: string,
    payload: any
  ): Promise<void> {
    await SecurityService._writeAuditEntry(client, eventType, payload);
  }

  /**
   * Shared implementation for audit log writes.
   * Accepts either a Pool or a PoolClient so it works in both contexts.
   *
   * Each row's hash = SHA256(eventType | payload | previousRowHash | timestamp).
   * A broken chain reveals tampering. Run verify_audit_log.ts to validate.
   */
  private static async _writeAuditEntry(
    db: any,
    eventType: string,
    payload: any
  ): Promise<void> {
    // Serialize the global hash chain. Without this transaction-scoped lock,
    // concurrent events can read the same previous hash and fork the chain.
    await db.query('SELECT pg_advisory_xact_lock(752991884322001::bigint)');

    // Fetch the hash of the most recent audit row (chain link)
    const prevRes = await db.query(
      `SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`
    );
    const prevHash =
      prevRes.rows[0]?.row_hash ??
      '0000000000000000000000000000000000000000000000000000000000000000';

    const ts = new Date().toISOString();
    const payloadStr = JSON.stringify(payload);

    // Bind this row's hash to the previous row — break the chain = detect tampering
    const rowHash = crypto
      .createHash('sha256')
      .update(`${eventType}|${payloadStr}|${prevHash}|${ts}`)
      .digest('hex');

    await db.query(
      `INSERT INTO audit_log (event_type, payload, previous_hash, row_hash, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventType, payloadStr, prevHash, rowHash, ts]
    );
  }
}
