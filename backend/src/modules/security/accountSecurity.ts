import { Router } from 'express';
import { z } from 'zod';
import { retryDeadlockedTransaction } from '../../db/client';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import { SecurityService } from '../../services/security';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from '../governance/reviews';

const uuid = z.string().uuid();
const lifecycleActions = [
  'disable_account',
  'restore_account',
  'lost_contact_recovery',
  'mfa_reset',
] as const;
const emailPattern = /^[a-z0-9._%+-]+@[a-z0-9.-]+[.][a-z]{2,}$/;

const proposeLifecycleSchema = z
  .object({
    accountId: uuid,
    requestId: uuid,
    action: z.enum(lifecycleActions),
    reason: z.enum([
      'policy_violation',
      'departure',
      'account_restoration',
      'lost_contact',
      'lost_mfa_device',
      'mfa_compromise',
    ]),
    newEmail: z.string().trim().toLowerCase().max(254).regex(emailPattern).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const validReasons: Record<(typeof lifecycleActions)[number], readonly string[]> = {
      disable_account: ['policy_violation', 'departure'],
      restore_account: ['account_restoration'],
      lost_contact_recovery: ['lost_contact'],
      mfa_reset: ['lost_mfa_device', 'mfa_compromise'],
    };
    if (!validReasons[v.action].includes(v.reason)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid reason for lifecycle action' });
    }
    if (v.action === 'lost_contact_recovery' && !v.newEmail) {
      ctx.addIssue({ code: 'custom', message: 'Replacement email required' });
    }
    if (v.action !== 'lost_contact_recovery' && v.newEmail !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'Unexpected email parameter' });
    }
  });

const schemas = {
  list: z
    .object({
      before: uuid.optional(),
      accountId: uuid.optional(),
      state: z.enum(['all', 'held', 'available', 'disabled', 'pending_review']).default('all'),
    })
    .strict(),
  hold: z
    .object({
      accountId: uuid,
      requestId: uuid,
      reason: z.enum(['suspected_compromise', 'credential_exposure']),
    })
    .strict(),
  release: z.object({ holdId: uuid, requestId: uuid }).strict(),
  propose: proposeLifecycleSchema,
  review: z
    .object({
      proposalId: uuid,
      requestId: uuid,
      decision: z.enum(['approve', 'reject', 'withdraw']),
    })
    .strict(),
};

export async function accountSecurityCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: keyof typeof schemas,
  input: unknown
) {
  const parsed = schemas[operation].safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const isLifecycle = operation === 'propose' || operation === 'review';
  const commandFn = isLifecycle
    ? 'web_account_lifecycle_command'
    : 'web_account_security_command';
  const finishFn = isLifecycle
    ? 'web_account_lifecycle_finish'
    : 'web_account_security_finish';
  const auditEvent =
    operation === 'list'
      ? 'PLATFORM_ACCOUNT_SECURITY_READ'
      : operation === 'hold'
        ? 'PLATFORM_ACCOUNT_HELD'
        : operation === 'release'
          ? 'PLATFORM_ACCOUNT_RELEASED'
          : operation === 'propose'
            ? 'PLATFORM_ACCOUNT_LIFECYCLE_PROPOSED'
            : 'PLATFORM_ACCOUNT_LIFECYCLE_REVIEWED';

  try {
    return await retryDeadlockedTransaction(async (client) => {
      const args = [
        session.sessionId,
        session.sessionTokenHash,
        operation,
        JSON.stringify(parsed.data),
      ];
      const read = async () =>
        (await client.query(`SELECT ertad.${commandFn}($1,$2,$3,$4) result`, args)).rows[0].result;
      const result = await read();
      if (result.audit) {
        await SecurityService.logAuditEventInTransaction(client, auditEvent, result.audit);
      }
      if (operation === 'list') return (await read()).data;
      await client.query(`SELECT ertad.${finishFn}($1,$2,$3,$4)`, [
        session.sessionId,
        session.sessionTokenHash,
        operation,
        JSON.stringify(result.check),
      ]);
      return result.data;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    if (code === 'P0409' || code === '23505') {
      throw new ReviewError(409, 'ACCOUNT_SECURITY_CONFLICT');
    }
    if (['22023', '22P02', '23514'].includes(code ?? '')) {
      throw new ReviewError(400, 'INVALID_REQUEST');
    }
    throw error;
  }
}

export function createAccountSecurityRouter() {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .json(await accountSecurityCommand(req.adminSession!, 'list', req.query));
    } catch (error) {
      next(error);
    }
  });
  for (const op of ['hold', 'release'] as const) {
    router.post('/' + op, requireAdminCsrf, async (req, res, next) => {
      try {
        res
          .set('Cache-Control', 'no-store')
          .json(await accountSecurityCommand(req.adminSession!, op, req.body));
      } catch (error) {
        next(error);
      }
    });
  }
  for (const op of ['propose', 'review'] as const) {
    router.post('/lifecycle/' + op, requireAdminCsrf, async (req, res, next) => {
      try {
        res
          .set('Cache-Control', 'no-store')
          .json(await accountSecurityCommand(req.adminSession!, op, req.body));
      } catch (error) {
        next(error);
      }
    });
  }
  return router;
}
