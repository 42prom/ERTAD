import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { retryDeadlockedTransaction } from '../../db/client';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import { createErrorWithCode } from '../../middleware/errorHandler';
import { createLoginLimits } from '../security/securityLimits';
import { hashAdminPassword, validateAdminPassword } from '../../services/adminPassword';
import { SecurityService } from '../../services/security';
import type { AdminSessionIdentity } from '../../services/adminSession';

const uuid = z.string().uuid();
const list = z
  .object({ organizationId: uuid, page: z.coerce.number().int().min(1).max(1000).default(1) })
  .strict();
const schemas = {
  contexts: z.object({}).strict(),
  contacts: list,
  list,
  revoke: z.object({ organizationId: uuid, id: uuid }).strict(),
};
const activation = z
  .object({
    id: uuid,
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(14).max(72),
  })
  .strict();
const contactInput = z
  .object({
    organizationId: uuid,
    unitId: uuid,
    memberId: uuid,
    requestId: uuid,
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/),
  })
  .strict();
export async function contactCommand(
  identity: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: 'candidates' | 'create',
  input: unknown
) {
  const parsed = (operation === 'create' ? contactInput : list).safeParse(input);
  if (!parsed.success) return fail(400, 'INVALID_REQUEST');
  try {
    return await retryDeadlockedTransaction(async (client) => {
      const args = [
        identity.sessionId,
        identity.sessionTokenHash,
        operation,
        parsed.data.organizationId,
        JSON.stringify(parsed.data),
      ];
      const read = async () =>
        (await client.query('SELECT ertad.web_contact_command($1,$2,$3,$4,$5) result', args))
          .rows[0].result;
      const value = await read();
      await SecurityService.logAuditEventInTransaction(client, 'WEB_CONTACT_COMMAND', value.audit);
      return (await read()).data;
    });
  } catch (error) {
    return translate(error);
  }
}
export async function confirmContact(input: unknown) {
  const parsed = activation.omit({ password: true }).safeParse(input);
  if (!parsed.success) return fail(400, 'INVALID_REQUEST');
  const { id, token } = parsed.data,
    digest = createHash('sha256').update(token).digest('hex');
  try {
    await retryDeadlockedTransaction(async (client) => {
      await client.query('SELECT ertad.web_contact_confirm($1,$2)', [id, digest]);
      await SecurityService.logAuditEventInTransaction(client, 'WEB_CONTACT_CONFIRMED', {
        invitationId: id,
      });
      await client.query('SELECT ertad.web_contact_confirm($1,$2,true)', [id, digest]);
    });
  } catch (error) {
    return translate(error);
  }
  return { verified: true as const };
}
export async function revokePendingContact(
  identity: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  input: unknown
) {
  const parsed = z.object({ organizationId: uuid, id: uuid }).strict().safeParse(input);
  if (!parsed.success) return fail(400, 'INVALID_REQUEST');
  try {
    return await retryDeadlockedTransaction(async (client) => {
      const args = [
        identity.sessionId,
        identity.sessionTokenHash,
        parsed.data.organizationId,
        parsed.data.id,
      ];
      const first = (
        await client.query('SELECT ertad.web_contact_revoke($1,$2,$3,$4) result', args)
      ).rows[0].result;
      if (first.changed)
        await SecurityService.logAuditEventInTransaction(
          client,
          'WEB_CONTACT_REVOKED',
          first.audit
        );
      return (await client.query('SELECT ertad.web_contact_revoke($1,$2,$3,$4,true) result', args))
        .rows[0].result.data;
    });
  } catch (error) {
    return translate(error);
  }
}
function fail(status: number, code: string): never {
  throw createErrorWithCode(code, code, status);
}
function translate(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') return fail(403, 'ACCESS_DENIED');
  if (code === 'P0428') return fail(428, 'ADMIN_STEP_UP_REQUIRED');
  if (code === 'P0409' || code === '23505') return fail(409, 'INVITATION_UNAVAILABLE');
  if (['22023', '23514', '22P02'].includes(code ?? '')) return fail(400, 'INVALID_REQUEST');
  throw error;
}
export async function invitationCommand(
  identity: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: keyof typeof schemas,
  input: unknown
) {
  const parsed = schemas[operation].safeParse(input);
  if (!parsed.success) return fail(400, 'INVALID_REQUEST');
  const args = parsed.data;
  try {
    return await retryDeadlockedTransaction(async (client) => {
      const params = [
        identity.sessionId,
        identity.sessionTokenHash,
        operation,
        'organizationId' in args ? args.organizationId : null,
        JSON.stringify(args),
      ];
      const read = async () =>
        (await client.query('SELECT ertad.web_invite_command($1,$2,$3,$4,$5) result', params))
          .rows[0].result;
      const result = await read();
      await SecurityService.logAuditEventInTransaction(
        client,
        'WEB_INVITATION_COMMAND',
        result.audit
      );
      if (operation === 'revoke') params[2] = 'revoke_check';
      return (await read()).data;
    });
  } catch (error) {
    return translate(error);
  }
}
export async function activateInvitation(input: unknown) {
  const parsed = activation.safeParse(input);
  if (!parsed.success) return fail(400, 'INVALID_REQUEST');
  const { id, token, password } = parsed.data;
  if (validateAdminPassword(password)) return fail(400, 'PASSWORD_POLICY');
  const digest = createHash('sha256').update(token).digest('hex');
  const passwordHash = await hashAdminPassword(password);
  try {
    return await retryDeadlockedTransaction(async (client) => {
      const prepared = (
        await client.query('SELECT ertad.web_invite_activate($1,$2) result', [id, digest])
      ).rows[0].result;
      if (validateAdminPassword(password, prepared.email)) return fail(400, 'PASSWORD_POLICY');
      const result = (
        await client.query('SELECT ertad.web_invite_activate($1,$2,$3) result', [
          id,
          digest,
          passwordHash,
        ])
      ).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'WEB_INVITATION_ACTIVATED', {
        invitationId: id,
        adminUserId: result.accountId,
      });
      await client.query('SELECT ertad.web_invite_activation_finish($1,$2,$3,$4)', [
        id,
        digest,
        result.accountId,
        passwordHash,
      ]);
      return { activated: true as const };
    });
  } catch (error) {
    return translate(error);
  }
}
export function createInvitationsRouter() {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    throw new Error('Invitation production enrollment is not enabled');
  const router = Router();
  router.post('/confirm-email', createLoginLimits(), async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(await confirmContact(req.body));
    } catch (error) {
      next(error);
    }
  });
  router.post('/activate', createLoginLimits(), async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(await activateInvitation(req.body));
    } catch (error) {
      next(error);
    }
  });
  router.use(requireAdmin);
  router.post('/contact/revoke', requireAdminCsrf, async (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .json(await revokePendingContact(req.adminSession!, req.body));
    } catch (error) {
      next(error);
    }
  });
  router.get('/candidates', async (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .json(await contactCommand(req.adminSession!, 'candidates', req.query));
    } catch (error) {
      next(error);
    }
  });
  router.post('/contact', requireAdminCsrf, async (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .json(await contactCommand(req.adminSession!, 'create', req.body));
    } catch (error) {
      next(error);
    }
  });
  for (const operation of Object.keys(schemas) as (keyof typeof schemas)[]) {
    const write = operation === 'revoke';
    router[write ? 'post' : 'get'](
      '/' + operation,
      ...(write ? [requireAdminCsrf] : []),
      async (req, res, next) => {
        try {
          res
            .set('Cache-Control', 'no-store')
            .json(
              await invitationCommand(req.adminSession!, operation, write ? req.body : req.query)
            );
        } catch (error) {
          next(error);
        }
      }
    );
  }
  return router;
}
