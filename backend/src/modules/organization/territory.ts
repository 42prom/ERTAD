import { Router } from 'express';
import { z } from 'zod';
import { retryDeadlockedTransaction } from '../../db/client';
import { SecurityService } from '../../services/security';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from '../governance/reviews';
import { publishRealtimeSignal } from '../communication/realtime';

const uuid = z.string().uuid();
const geographicAreaId = z.string().regex(/^GE-[A-Z0-9-]+$/).max(80);
const reason = z.string().trim().min(10).max(1000);

const schemas = {
  catalogue: z.object({}).strict(),
  groups: z
    .object({
      organizationId: uuid,
      areaId: geographicAreaId.optional(),
    })
    .strict(),
  my_groups: z.object({ organizationId: uuid }).strict(),
  group_options: z.object({ organizationId: uuid, unitId: uuid }).strict(),
  request_admission: z
    .object({
      organizationId: uuid,
      unitId: uuid,
      key: uuid,
      reason,
      expiresAt: z.string().datetime({ offset: true }).optional(),
      validUntil: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
  set_primary: z
    .object({
      organizationId: uuid,
      membershipId: uuid.nullable().optional(),
    })
    .strict(),
  configure_group: z
    .object({
      organizationId: uuid,
      unitId: uuid,
      admissionOpen: z.boolean(),
      admissionPositionId: uuid.nullable().optional(),
    })
    .strict()
    .refine((v) => !v.admissionOpen || Boolean(v.admissionPositionId)),
};

export type TerritoryOperation = keyof typeof schemas;

export async function territoryCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: TerritoryOperation,
  input: unknown
): Promise<any> {
  const parsed = schemas[operation].safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const args = parsed.data;
  const organization = 'organizationId' in args ? args.organizationId : null;
  const params = [
    session.sessionId,
    session.sessionTokenHash,
    operation,
    organization,
    JSON.stringify(args),
  ];
  const requiresStepUp = operation === 'configure_group';
  const isRead = ['catalogue', 'groups', 'my_groups', 'group_options'].includes(operation);

  try {
    const out = await retryDeadlockedTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const response = (
        await client.query('SELECT ertad.territory_command($1,$2,$3,$4,$5) AS result', params)
      ).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'TERRITORY_COMMAND', response.audit);
      await client.query('SELECT ertad.review_identity($1,$2,$3)', [
        session.sessionId,
        session.sessionTokenHash,
        requiresStepUp,
      ]);
      if (isRead) {
        return (
          await client.query('SELECT ertad.territory_command($1,$2,$3,$4,$5) AS result', params)
        ).rows[0].result.data;
      }
      return response.data;
    });

    if (operation === 'request_admission') {
      publishRealtimeSignal({
        topic: 'review',
        organizationId: organization ?? undefined,
      });
    } else if (operation === 'configure_group') {
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
    if (code === '22023' || code === '22P02' || code === '23514') {
      throw new ReviewError(400, 'INVALID_REQUEST');
    }
    throw error;
  }
}

export function createTerritoryRouter(): Router {
  const router = Router();
  router.use(requireAdmin);
  router.use((req, res, next) =>
    ['GET', 'HEAD'].includes(req.method) ? next() : requireAdminCsrf(req, res, next)
  );
  for (const [method, path, operation] of [
    ['get', '/catalogue', 'catalogue'],
    ['get', '/groups', 'groups'],
    ['get', '/my-groups', 'my_groups'],
    ['get', '/group-options', 'group_options'],
    ['post', '/admissions', 'request_admission'],
    ['post', '/primary-group', 'set_primary'],
    ['post', '/group-settings', 'configure_group'],
  ] as const) {
    router[method](path, async (req, res, next) => {
      try {
        res.json(
          await territoryCommand(
            req.adminSession!,
            operation,
            method === 'get' ? req.query : req.body
          )
        );
      } catch (error) {
        next(error);
      }
    });
  }
  return router;
}
