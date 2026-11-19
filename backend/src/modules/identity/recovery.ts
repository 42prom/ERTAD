import { createHash } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { retryDeadlockedTransaction } from '../../db/client';
import { createErrorWithCode } from '../../middleware/errorHandler';
import { hashAdminPassword, validateAdminPassword } from '../../services/adminPassword';
import { SecurityService } from '../../services/security';
import { rateLimitKey, requestSecurityLimits } from '../security/securityLimits';

const requestSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(254) })
  .strict();
const consumeSchema = z
  .object({
    id: z.string().uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(14).max(72),
  })
  .strict();
const fail = (status: number, code: string): never => {
  throw createErrorWithCode(code, code, status);
};
export async function requestRecovery(input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return fail(400, 'INVALID_REQUEST');
  try {
    await retryDeadlockedTransaction(async (client) => {
      const id = (
        await client.query('SELECT ertad.web_recovery_request($1) id', [parsed.data.email])
      ).rows[0].id;
      // The public acknowledgement and audit shape never identify the supplied account.
      await SecurityService.logAuditEventInTransaction(client, 'WEB_RECOVERY_REQUESTED', {});
      await client.query('SELECT ertad.web_recovery_request_finish($1)', [id]);
    });
  } catch (error) {
    // Eligibility changes during audit roll back silently, just like an unknown contact.
    if ((error as { code?: string }).code !== 'P0409') throw error;
  }
  return { accepted: true as const };
}
export async function completeRecovery(input: unknown) {
  const parsed = consumeSchema.safeParse(input);
  if (!parsed.success) return fail(400, 'INVALID_REQUEST');
  const { id, token, password } = parsed.data;
  if (validateAdminPassword(password)) return fail(400, 'PASSWORD_POLICY');
  const digest = createHash('sha256').update(token).digest('hex');
  const nextHash = await hashAdminPassword(password);
  try {
    await retryDeadlockedTransaction(async (client) => {
      const prepared = (
        await client.query('SELECT ertad.web_recovery_consume($1,$2) data', [id, digest])
      ).rows[0].data;
      if (
        validateAdminPassword(password, prepared.email) ||
        (await bcrypt.compare(password, prepared.passwordHash))
      )
        return fail(400, 'PASSWORD_POLICY');
      const result = (
        await client.query('SELECT ertad.web_recovery_consume($1,$2,$3) data', [
          id,
          digest,
          nextHash,
        ])
      ).rows[0].data;
      await SecurityService.logAuditEventInTransaction(client, 'WEB_RECOVERY_COMPLETED', {
        recoveryId: id,
        adminUserId: result.accountId,
      });
      await client.query('SELECT ertad.web_recovery_finish($1,$2,$3)', [id, digest, nextHash]);
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'P0409') return fail(409, 'RECOVERY_UNAVAILABLE');
    if (['22023', '22P02', '23514'].includes(code ?? '')) return fail(400, 'INVALID_REQUEST');
    throw error;
  }
  return { recovered: true as const };
}
export function createRecoveryRouter() {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    throw new Error('Production recovery is not enabled');
  const router = Router();
  // Count successes too: an intentionally generic 200 must not enable mailbox flooding.
  router.use(
    rateLimit({
      windowMs: 15 * 60_000,
      limit: (_req, res) => requestSecurityLimits(res).loginFailures,
      keyGenerator: rateLimitKey,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({ error: { code: 'RATE_LIMITED' }, requestId: res.locals.requestId }),
    })
  );
  for (const [path, command] of [
    ['/request', requestRecovery],
    ['/complete', completeRecovery],
  ] as const) {
    router.post(path, async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store').json(await command(req.body));
      } catch (error) {
        next(error);
      }
    });
  }
  return router;
}
