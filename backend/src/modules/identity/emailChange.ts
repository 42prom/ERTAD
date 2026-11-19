import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { retryDeadlockedTransaction } from '../../db/client';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import { createErrorWithCode } from '../../middleware/errorHandler';
import { SecurityService } from '../../services/security';
import { encryptSensitiveValue } from '../../services/secretEncryption';
import { clearAdminSessionCookie, type AdminSessionIdentity } from '../../services/adminSession';
const uuid = z.string().uuid(),
  email = z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(254)
    .regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/);
const schemas = {
  read: z.object({}).strict(),
  request: z.object({ requestId: uuid, newEmail: email }).strict(),
  cancel: z.object({ id: uuid }).strict(),
  confirm: z
    .object({ id: uuid, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), newEmail: email })
    .strict(),
};
export async function ownEmailCommand(
  identity: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: keyof typeof schemas,
  input: unknown
) {
  const parsed = schemas[operation].safeParse(input);
  if (!parsed.success) throw createErrorWithCode('INVALID_REQUEST', 'Invalid request', 400);
  const args =
    'token' in parsed.data
      ? {
          id: parsed.data.id,
          newEmail: parsed.data.newEmail,
          digest: createHash('sha256').update(parsed.data.token).digest('hex'),
        }
      : parsed.data;
  const noticeNonce = randomBytes(32).toString('base64url'),
    noticeDigest = createHash('sha256').update(noticeNonce).digest('hex'),
    noticeCipher = encryptSensitiveValue(noticeNonce);
  try {
    return await retryDeadlockedTransaction(async (client) => {
      const params = [
        identity.sessionId,
        identity.sessionTokenHash,
        operation,
        JSON.stringify(args),
      ];
      const read = async () =>
        (await client.query('SELECT ertad.own_email_command($1,$2,$3,$4) result', params)).rows[0]
          .result;
      const result = await read();
      let noticeId: string | undefined;
      if (operation === 'confirm' && 'id' in args) {
        noticeId = (
          await client.query('SELECT ertad.security_mail_prepare($1,$2,$3,$4) id', [
            'email_changed',
            args.id,
            noticeDigest,
            noticeCipher,
          ])
        ).rows[0].id;
      }
      if (result.audit)
        await SecurityService.logAuditEventInTransaction(
          client,
          operation === 'confirm'
            ? 'WEB_EMAIL_CHANGED'
            : operation === 'request'
              ? 'WEB_EMAIL_CHANGE_REQUESTED'
              : operation === 'cancel'
                ? 'WEB_EMAIL_CHANGE_CANCELLED'
                : 'WEB_EMAIL_CHANGE_READ',
          result.audit
        );
      if (operation === 'confirm' && 'id' in args && 'digest' in args) {
        await client.query('SELECT ertad.own_email_finish($1,$2,$3,$4,$5)', [
          identity.sessionId,
          identity.sessionTokenHash,
          args.id,
          args.digest,
          JSON.stringify({ ...result.check, noticeId, noticeDigest }),
        ]);
        return result.data;
      }
      if (operation === 'cancel') params[2] = 'cancel_check';
      return (await read()).data;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501')
      throw createErrorWithCode('SESSION_UNAVAILABLE', 'Session unavailable', 403);
    if (code === 'P0428')
      throw createErrorWithCode('ADMIN_STEP_UP_REQUIRED', 'Confirm your password', 428);
    if (code === 'P0409' || code === '23505')
      throw createErrorWithCode('EMAIL_CHANGE_UNAVAILABLE', 'Email change unavailable', 409);
    if (['22023', '23514', '22P02'].includes(code ?? ''))
      throw createErrorWithCode('INVALID_REQUEST', 'Invalid request', 400);
    throw error;
  }
}
/** Mounted under the authenticated personal-account router. */
export function createEmailChangeRouter() {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .json(await ownEmailCommand(req.adminSession!, 'read', req.query));
    } catch (error) {
      next(error);
    }
  });
  for (const operation of ['request', 'cancel', 'confirm'] as const)
    router.post('/' + operation, requireAdminCsrf, async (req, res, next) => {
      try {
        const result = await ownEmailCommand(req.adminSession!, operation, req.body);
        if (operation === 'confirm') {
          clearAdminSessionCookie(res);
          res.set('Clear-Site-Data', '"cache"');
        }
        res.set('Cache-Control', 'no-store').json(result);
      } catch (error) {
        next(error);
      }
    });
  return router;
}
