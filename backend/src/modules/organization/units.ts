import { Router } from 'express';
import { z } from 'zod';
import { transaction } from '../../db/client';
import { SecurityService } from '../../services/security';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from '../governance/reviews';
import { publishRealtimeSignal } from '../communication/realtime';

const uuid = z.string().uuid(),
  reason = z.string().trim().min(10).max(1000);
const org = z.object({ organizationId: uuid }),
  page = z.coerce.number().int().min(1).max(1000).default(1);
const operationalType = z.enum(['unclassified', 'region', 'locality', 'group', 'team']);
const geographicAreaId = z.string().regex(/^GE-[A-Z0-9-]+$/).max(80);
const schemas = {
  contexts: z.object({}).strict(),
  geography: org.strict(),
  units: org
    .extend({
      page,
      search: z.string().max(80).default(''),
      status: z.enum(['active', 'archived']).default('active'),
    })
    .strict(),
  list: org
    .extend({ page, view: z.enum(['pending', 'mine', 'history']).default('pending') })
    .strict(),
  detail: org.extend({ id: uuid }).strict(),
  propose: org
    .extend({
      key: uuid,
      parentId: uuid,
      name: z.string().trim().min(1).max(160),
      reason,
      expiresAt: z.string().datetime({ offset: true }),
      operationalType: operationalType.optional(),
      geographicAreaId: geographicAreaId.optional(),
    })
    .strict(),
  change: org
    .extend({
      key: uuid,
      unitId: uuid,
      version: z.number().int().min(0),
      kind: z.enum(['rename', 'archive', 'restore', 'territory']),
      operationalType: operationalType.exclude(['unclassified']).optional(),
      geographicAreaId: geographicAreaId.optional(),
      name: z.string().trim().min(1).max(160).optional(),
      reason,
      expiresAt: z.string().datetime({ offset: true }),
    })
    .strict()
    .refine((v) => (v.kind === 'rename' ? v.name !== undefined : v.name === undefined))
    .refine((v) => v.kind === 'territory'
      ? v.operationalType !== undefined && v.geographicAreaId !== undefined
      : v.operationalType === undefined && v.geographicAreaId === undefined),
  decide: org
    .extend({ id: uuid, key: uuid, decision: z.enum(['approved', 'rejected']), reason })
    .strict(),
};
export async function unitCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: keyof typeof schemas,
  input: unknown
): Promise<any> {
  const parsed = schemas[operation].safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const args = parsed.data,
    organization = 'organizationId' in args ? args.organizationId : null;
  const params = [
    session.sessionId,
    session.sessionTokenHash,
    operation,
    organization,
    JSON.stringify(args),
  ];
  try {
    const out = await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const response = (
        await client.query('SELECT ertad.unit_command($1,$2,$3,$4,$5) AS result', params)
      ).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'UNIT_REVIEW', response.audit);
      if (response.audit.changed) {
        await client.query('SELECT ertad.unit_review_finish($1,$2,$3,$4)', [
          session.sessionId,
          session.sessionTokenHash,
          organization,
          response.audit.reviewId,
        ]);
        return response.data;
      }
      // Re-evaluate live scope and deadlines after waiting for audit persistence.
      return (await client.query('SELECT ertad.unit_command($1,$2,$3,$4,$5) AS result', params))
        .rows[0].result.data;
    });
    if (['propose', 'change', 'decide'].includes(operation)) {
      publishRealtimeSignal({
        topic: 'unit',
        organizationId: organization ?? undefined,
      });
    }
    return out;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    if (code === 'P0409' || code === '23505') throw new ReviewError(409, 'REVIEW_CONFLICT');
    if (code === '22023' || code === '23514') throw new ReviewError(400, 'INVALID_REQUEST');
    throw error;
  }
}
export function createUnitRouter(): Router {
  const router = Router();
  router.use(requireAdmin);
  router.use((req, res, next) =>
    ['GET', 'HEAD'].includes(req.method) ? next() : requireAdminCsrf(req, res, next)
  );
  for (const [method, path, operation] of [
    ['get', '/contexts', 'contexts'],
    ['get', '/geography', 'geography'],
    ['get', '/', 'units'],
    ['get', '/reviews', 'list'],
    ['get', '/detail', 'detail'],
    ['post', '/reviews', 'propose'],
    ['post', '/changes', 'change'],
    ['post', '/decision', 'decide'],
  ] as const) {
    router[method](path, async (req, res, next) => {
      try {
        res.json(
          await unitCommand(req.adminSession!, operation, method === 'get' ? req.query : req.body)
        );
      } catch (error) {
        next(error);
      }
    });
  }
  return router;
}
