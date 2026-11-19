import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SecurityService } from '../../services/security';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Reviewed installer definition: participants cannot author or expand this bundle.
const PERMISSIONS = ['unit.read', 'workitem.create', 'workitem.verify', 'membership.propose', 'membership.approve'] as const;
const LOCK = 42420003;

export class BootstrapDenied extends Error {
  constructor() { super('Governance bootstrap unavailable or request rejected'); }
}

export interface BootstrapPlan {
  id: string;
  proposerAccountId: string;
  confirmerAccountId: string;
  organizationName: string;
  reason: string;
}

type Row = {
  id: string; proposer_account_id: string; confirmer_account_id: string;
  organization_name: string; status: 'armed' | 'pending' | 'completed' | 'rejected';
  expires_at: Date; proposer_session_id: string | null; confirmer_session_id: string | null;
  organization_id: string | null;
};
export type BootstrapResult = { id: string; status: Row['status']; organizationId: string | null };
const projection = (row: Row): BootstrapResult => ({ id: row.id, status: row.status, organizationId: row.organization_id });

/** Offline development/test installer only; never give the HTTP API an owner pool. */
export class GovernanceBootstrap {
  constructor(private readonly ownerPool: Pool) {}

  private async run<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? '') || process.env.ERTAD_BOOTSTRAP_MODE !== 'true') {
      throw new BootstrapDenied();
    }
    const client = await this.ownerPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const owner = (await client.query<{ owns: boolean }>(`SELECT n.nspowner = r.oid AS owns
        FROM pg_namespace n JOIN pg_roles r ON r.rolname = current_user WHERE n.nspname = 'ertad'`)).rows[0];
      if (!owner?.owns) throw new BootstrapDenied();
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async eligible(client: PoolClient): Promise<void> {
    // Prevent a concurrent installer/enrollment from creating an identity or tenant
    // between the emptiness check and commit. Existing web login accounts may exist.
    await client.query('LOCK TABLE ertad.member_users, ertad.organizations IN SHARE ROW EXCLUSIVE MODE');
    const { exists } = (await client.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM ertad.member_users)
      OR EXISTS (SELECT 1 FROM ertad.organizations) AS exists`)).rows[0];
    if (exists) throw new BootstrapDenied();
  }

  private async activeAccounts(client: PoolClient, ids: string[]): Promise<void> {
    const result = await client.query(`SELECT id, is_active, locked_until FROM ertad.admin_users
      WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`, [ids]);
    const now = await this.now(client);
    if (result.rowCount !== ids.length || result.rows.some(row => !row.is_active
      || (row.locked_until !== null && !(row.locked_until instanceof Date && row.locked_until.getTime() <= now)))) {
      throw new BootstrapDenied();
    }
  }

  private async now(client: PoolClient): Promise<number> {
    return (await client.query<{ now: number }>('SELECT extract(epoch FROM clock_timestamp()) * 1000::float8 AS now')).rows[0].now;
  }

  private async session(client: PoolClient, accountId: string, token?: string, sessionId?: string): Promise<string> {
    if (token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BootstrapDenied();
    const hash = token === undefined ? null : createHash('sha256').update(token).digest('hex');
    const result = await client.query(`SELECT id, revoked_at, idle_expires_at, absolute_expires_at, step_up_expires_at
      FROM ertad.admin_sessions WHERE admin_user_id = $1
        AND (($2::text IS NOT NULL AND token_hash = $2) OR ($2::text IS NULL AND id = $3::uuid)) FOR SHARE`,
    [accountId, hash, sessionId ?? null]);
    const row = result.rows[0];
    const now = await this.now(client);
    if (!row || row.revoked_at !== null || [row.idle_expires_at, row.absolute_expires_at, row.step_up_expires_at]
      .some(value => !(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() <= now)) {
      throw new BootstrapDenied();
    }
    return row.id;
  }

  private async pending(client: PoolClient, id: string): Promise<Row> {
    if (!UUID.test(id)) throw new BootstrapDenied();
    const row = (await client.query<Row>('SELECT * FROM ertad.governance_bootstrap WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new BootstrapDenied();
    return row;
  }

  private async unexpired(client: PoolClient, row: Row): Promise<void> {
    if (row.expires_at.getTime() <= await this.now(client)) throw new BootstrapDenied();
  }

  private async event(client: PoolClient, row: Row, action: string, actor: string | null, recipient: string | null): Promise<void> {
    await client.query(`INSERT INTO ertad.governance_bootstrap_events
      (bootstrap_id, action, actor_account_id, recipient_account_id) VALUES ($1, $2, $3, $4)`, [row.id, action, actor, recipient]);
    await SecurityService.logAuditEventInTransaction(client, `GOVERNANCE_BOOTSTRAP_${action.toUpperCase()}`, {
      bootstrapId: row.id, actorAccountId: actor, recipientAccountId: recipient,
      ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    });
  }

  async arm(plan: BootstrapPlan): Promise<BootstrapResult> {
    if (![plan.id, plan.proposerAccountId, plan.confirmerAccountId].every(value => typeof value === 'string' && UUID.test(value))
      || plan.proposerAccountId === plan.confirmerAccountId
      || typeof plan.organizationName !== 'string' || !plan.organizationName.trim() || plan.organizationName.length > 160
      || typeof plan.reason !== 'string' || plan.reason.trim().length < 10 || plan.reason.length > 1000) throw new BootstrapDenied();
    return this.run(async client => {
      // Even an identical completed or rejected plan may never rearm the installation.
      if ((await client.query('SELECT 1 FROM ertad.governance_bootstrap')).rowCount) throw new BootstrapDenied();
      await this.eligible(client);
      await this.activeAccounts(client, [plan.proposerAccountId, plan.confirmerAccountId]);
      const row = (await client.query<Row>(`INSERT INTO ertad.governance_bootstrap
        (id, proposer_account_id, confirmer_account_id, organization_name, reason, expires_at)
        VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '10 minutes') RETURNING *`,
      [plan.id, plan.proposerAccountId, plan.confirmerAccountId, plan.organizationName.trim(), plan.reason.trim()])).rows[0];
      await this.event(client, row, 'armed', null, null);
      await this.unexpired(client, row);
      return projection(row);
    });
  }

  async propose(id: string, sessionToken: string): Promise<BootstrapResult> {
    return this.run(async client => {
      const row = await this.pending(client, id);
      if (!['armed', 'pending'].includes(row.status)) throw new BootstrapDenied();
      await this.eligible(client);
      await this.activeAccounts(client, [row.proposer_account_id, row.confirmer_account_id]);
      const sessionId = await this.session(client, row.proposer_account_id, sessionToken);
      await this.unexpired(client, row);
      if (row.status === 'pending') {
        if (sessionId !== row.proposer_session_id) throw new BootstrapDenied();
        return projection(row); // Exact retry: no additional event or grant.
      }
      await client.query("UPDATE ertad.governance_bootstrap SET status = 'pending', proposer_session_id = $1 WHERE id = $2", [sessionId, id]);
      row.status = 'pending';
      // Each endorsement names the OTHER recipient, never the actor's own grant.
      await this.event(client, row, 'proposed', row.proposer_account_id, row.confirmer_account_id);
      await this.session(client, row.proposer_account_id, sessionToken);
      await this.unexpired(client, row);
      return projection(row);
    });
  }

  async decide(id: string, sessionToken: string, decision: 'confirm' | 'reject'): Promise<BootstrapResult> {
    if (!['confirm', 'reject'].includes(decision)) throw new BootstrapDenied();
    return this.run(async client => {
      const row = await this.pending(client, id);
      await this.activeAccounts(client, [row.proposer_account_id, row.confirmer_account_id]);
      const confirmerSession = await this.session(client, row.confirmer_account_id, sessionToken);
      const finalStatus = decision === 'confirm' ? 'completed' : 'rejected';
      if (row.status === finalStatus && row.confirmer_session_id === confirmerSession) return projection(row);
      if (row.status !== 'pending') throw new BootstrapDenied();
      await this.eligible(client);
      await this.session(client, row.proposer_account_id, undefined, row.proposer_session_id!);
      await this.unexpired(client, row);
      let organizationId: string | null = null;
      if (decision === 'confirm') {
        organizationId = randomUUID();
        const rootId = randomUUID();
        const bundleId = randomUUID();
        const positionId = randomUUID();
        await client.query('INSERT INTO ertad.organizations(id, name) VALUES ($1, $2)', [organizationId, row.organization_name]);
        await client.query(`INSERT INTO ertad.units(organization_id, id, name, kind)
          VALUES ($1, $2, $3, 'authority')`, [organizationId, rootId, row.organization_name]);
        await client.query('INSERT INTO ertad.permission_bundles(organization_id, id, version) VALUES ($1, $2, 1)', [organizationId, bundleId]);
        for (const permission of PERMISSIONS) {
          await client.query("INSERT INTO ertad.permission_grants VALUES ($1, $2, 1, $3, 'subtree')", [organizationId, bundleId, permission]);
        }
        await client.query("UPDATE ertad.permission_bundles SET status = 'approved' WHERE organization_id = $1 AND id = $2", [organizationId, bundleId]);
        await client.query(`INSERT INTO ertad.positions(organization_id, id, unit_id, name, bundle_id, bundle_version)
          VALUES ($1, $2, $3, 'Initial coordinator', $4, 1)`, [organizationId, positionId, rootId, bundleId]);
        for (const account of [row.proposer_account_id, row.confirmer_account_id]) {
          const userId = randomUUID();
          await client.query('INSERT INTO ertad.member_users(id, web_account_id) VALUES ($1, $2)', [userId, account]);
          await client.query(`INSERT INTO ertad.memberships(organization_id, user_id, unit_id, position_id, bundle_version, valid_from)
            VALUES ($1, $2, $3, $4, 1, clock_timestamp())`, [organizationId, userId, rootId, positionId]);
        }
      }
      await client.query(`UPDATE ertad.governance_bootstrap SET status = $1, confirmer_session_id = $2, organization_id = $3
        WHERE id = $4`, [finalStatus, confirmerSession, organizationId, id]);
      row.status = finalStatus; row.organization_id = organizationId;
      await this.event(client, row, decision === 'confirm' ? 'confirmed' : 'rejected', row.confirmer_account_id, row.proposer_account_id);
      // Recheck deadlines after waiting on the shared audit chain. Any failure rolls
      // back the organization, both grants, ceremony state and history together.
      await this.session(client, row.proposer_account_id, undefined, row.proposer_session_id!);
      await this.session(client, row.confirmer_account_id, sessionToken);
      await this.unexpired(client, row);
      return projection(row);
    });
  }
}
