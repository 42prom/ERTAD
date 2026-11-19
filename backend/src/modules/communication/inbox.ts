import { Router } from 'express';
import { z } from 'zod';
import { transaction } from '../../db/client';
import { SecurityService } from '../../services/security';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from '../governance/reviews';
import { publishRealtimeSignal } from './realtime';

const source = z.enum(['membership', 'unit', 'work', 'collective', 'decision', 'moderation', 'contribution', 'event']);
const schemas = {
  summary: z.object({}).strict(),
  list: z
    .object({
      organizationId: z.string().uuid(),
      source: source.or(z.literal('all')).default('all'),
      view: z.enum(['all', 'unread', 'action']).default('action'),
      page: z.coerce.number().int().min(1).max(1000).default(1),
    })
    .strict(),
  read: z
    .object({
      organizationId: z.string().uuid(),
      source,
      id: z.string().uuid(),
      version: z.number().int().positive(),
    })
    .strict(),
};
export type InboxOperation = keyof typeof schemas;
export async function inboxCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: InboxOperation,
  input: unknown
): Promise<any> {
  const parsed = schemas[operation].safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const args = parsed.data,
    params = [
      session.sessionId,
      session.sessionTokenHash,
      operation,
      'organizationId' in args ? args.organizationId : null,
      JSON.stringify(args),
    ];
  try {
    const out = await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const query = 'SELECT ertad.inbox_command($1,$2,$3,$4,$5) AS result';
      const response = (await client.query(query, params)).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'INBOX_COMMAND', response.audit);
      // Recheck current scope/expiry after audit. Reads are monotonic and exact-version
      // acknowledgements are idempotent; repeating cannot consume a newer notification.
      return (await client.query(query, params)).rows[0].result.data;
    });
    if (operation === 'read') {
      publishRealtimeSignal({
        topic: 'inbox',
        organizationId: 'organizationId' in args ? args.organizationId : undefined,
      });
    }
    return out;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0409') throw new ReviewError(409, 'INBOX_CONFLICT');
    if (['22023', '22P02', '23514'].includes(code ?? ''))
      throw new ReviewError(400, 'INVALID_REQUEST');
    throw error;
  }
}
export function createInboxRouter(): Router {
  const router = Router();
  router.use(requireAdmin);
  router.get('/summary', async (req, res, next) => {
    try {
      res.json(await inboxCommand(req.adminSession!, 'summary', req.query));
    } catch (e) {
      next(e);
    }
  });
  router.get('/', async (req, res, next) => {
    try {
      res.json(await inboxCommand(req.adminSession!, 'list', req.query));
    } catch (e) {
      next(e);
    }
  });
  router.post('/read', requireAdminCsrf, async (req, res, next) => {
    try {
      res.json(await inboxCommand(req.adminSession!, 'read', req.body));
    } catch (e) {
      next(e);
    }
  });
  return router;
}
