import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { query, retryDeadlockedTransaction } from '../../db/client';
import { encryptSensitiveValue, decryptSensitiveValue } from '../../services/secretEncryption';
import { SecurityService } from '../../services/security';
import { sendSecurityMail, type DeliveryOutcome } from './mailTransport';
type Sender = (
  policy: unknown,
  message: {
    email: string;
    id: string;
    token: string;
    purpose: 'contact' | 'invitation' | 'recovery' | 'email_change' | 'email_changed';
  }
) => Promise<DeliveryOutcome>;
export async function deliverSecurityMailBatch(send: Sender = sendSecurityMail) {
  const policy = (await query('SELECT ertad.current_mail_policy() data')).rows[0].data;
  // Still reconcile expired leases while delivery is paused, without contacting a provider.
  const pending = (await query('SELECT ertad.security_mail_pending() data')).rows[0]
    .data as string[];
  if (!policy.deliveryEnabled || policy.mode !== 'enabled') return;
  const candidates = (await query('SELECT ertad.security_mail_candidates() data')).rows[0].data as {
    purpose: string;
    id: string;
  }[];
  for (const candidate of candidates) {
    const token = randomBytes(32).toString('base64url'),
      digest = createHash('sha256').update(token).digest('hex'),
      cipher = encryptSensitiveValue(token);
    try {
      const job = await retryDeadlockedTransaction(async (client) => {
        const args = [candidate.purpose, candidate.id, digest, cipher];
        const id = (await client.query('SELECT ertad.security_mail_prepare($1,$2,$3,$4) id', args))
          .rows[0].id as string | null;
        if (id) {
          await SecurityService.logAuditEventInTransaction(client, 'SECURITY_MAIL_PREPARED', {
            jobId: id,
            purpose: candidate.purpose,
          });
          await client.query('SELECT ertad.security_mail_prepare($1,$2,$3,$4)', args);
        }
        return id;
      });
      if (job && !pending.includes(job)) pending.push(job);
    } catch (error) {
      if (!['P0409', '42501'].includes((error as { code?: string }).code ?? '')) throw error;
    }
  }
  for (const id of pending) {
    const lease = randomUUID();
    const job = await retryDeadlockedTransaction(async (client) => {
      const read = async () =>
        (await client.query('SELECT ertad.security_mail_claim($1,$2) data', [id, lease])).rows[0]
          .data;
      const data = await read();
      if (!data) return null;
      await SecurityService.logAuditEventInTransaction(client, 'SECURITY_MAIL_ATTEMPTED', {
        jobId: id,
        purpose: data.purpose,
        policyVersion: data.policy.version,
      });
      return read();
    });
    if (!job) continue;
    let outcome: DeliveryOutcome = 'uncertain';
    try {
      const token = decryptSensitiveValue(job.tokenCipher);
      if (createHash('sha256').update(token).digest('hex') !== job.tokenHash) outcome = 'failed';
      else
        outcome = await send(job.policy, {
          email: job.email,
          id: job.id,
          token,
          purpose: job.purpose,
        });
    } catch {
      outcome = 'uncertain';
    }
    // Never repeat network effects when an audit/commit result is uncertain.
    await retryDeadlockedTransaction(async (client) => {
      await client.query('SELECT ertad.security_mail_finish($1,$2,$3)', [id, lease, outcome]);
      await SecurityService.logAuditEventInTransaction(client, 'SECURITY_MAIL_OUTCOME', {
        jobId: id,
        outcome,
      });
      await client.query('SELECT ertad.security_mail_finish_check($1,$2,$3)', [id, lease, outcome]);
    });
  }
}
export function startSecurityMailWorker(onError: () => void) {
  let running: Promise<void> | null = null,
    stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = deliverSecurityMailBatch()
      .catch(onError)
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
