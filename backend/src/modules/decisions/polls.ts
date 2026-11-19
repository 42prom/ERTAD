import { Router } from 'express';
import { z } from 'zod';
import { transaction } from '../../db/client';
import { SecurityService } from '../../services/security';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from '../governance/reviews';
import { definitionFields, validDefinition, answerValues } from './definitions';
import { publishRealtimeSignal } from '../communication/realtime';

const uuid = z.string().uuid();
const org = z.object({ organizationId: uuid });
const id = org.extend({ id: uuid });
const transition = id.extend({ key: uuid, version: z.number().int().positive() }).strict();

const unitIdList = z.preprocess(
  (v) => (typeof v === 'string' ? (v ? v.split(',') : []) : v),
  z.array(uuid).max(25)
);

const schemas = {
  contexts: z.object({}).strict(),
  audiences: org.strict(),
  estimate: org
    .extend({
      includedUnitIds: z.preprocess(
        (v) => (typeof v === 'string' ? (v ? v.split(',') : []) : v),
        z.array(uuid).min(1).max(25)
      ),
      excludedUnitIds: unitIdList.default([]),
      anonymousMinElectorate: z.coerce.number().int().min(2).max(1000).optional(),
    })
    .strict()
    .refine((v) => !v.excludedUnitIds.some((ex) => v.includedUnitIds.includes(ex))),
  list: org
    .extend({
      page: z.coerce.number().int().min(1).max(1000).default(1),
      view: z.enum(['draft', 'scheduled', 'open', 'closed', 'cancelled']).default('open'),
      search: z.string().max(80).default(''),
    })
    .strict(),
  report: org
    .extend({
      view: z.enum(['all', 'draft', 'scheduled', 'open', 'closed', 'cancelled']).default('all'),
      search: z.string().max(80).default(''),
    })
    .strict(),
  detail: id.strict(),
  create: org
    .extend({ key: uuid, ...definitionFields })
    .strict()
    .refine(validDefinition),
  update: id
    .extend({ key: uuid, version: z.number().int().positive(), ...definitionFields })
    .strict()
    .refine(validDefinition),
  nominate: transition
    .extend({ candidateLabel: z.string().trim().min(1).max(160) })
    .strict(),
  withdraw_nomination: transition
    .extend({
      candidateLabel: z.string().trim().min(1).max(160),
      reason: z.string().trim().min(3).max(1000),
    })
    .strict(),
  publish: transition,
  close: transition,
  cancel: transition,
  vote: z.union([
    id.extend({ key: uuid, choice: z.number().int().min(0).max(7) }).strict(),
    id.extend({ key: uuid, answers: answerValues }).strict(),
  ]),
};

export async function decisionCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: keyof typeof schemas,
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
  const mutation = [
    'create',
    'update',
    'nominate',
    'withdraw_nomination',
    'publish',
    'close',
    'cancel',
    'vote',
  ].includes(operation);
  try {
    const out = await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const response = (
        await client.query('SELECT ertad.decision_command($1,$2,$3,$4,$5) AS result', params)
      ).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'DECISION_COMMAND', response.audit);
      if (mutation) {
        await client.query('SELECT ertad.decision_finish($1,$2,$3,$4,$5,$6)', [
          session.sessionId,
          session.sessionTokenHash,
          organization,
          response.audit.decisionId,
          operation,
          response.audit.changed,
        ]);
        return response.data;
      }
      return (await client.query('SELECT ertad.decision_command($1,$2,$3,$4,$5) AS result', params))
        .rows[0].result.data;
    });
    if (mutation) {
      publishRealtimeSignal({
        topic: 'decision',
        organizationId: organization ?? undefined,
      });
    }
    return out;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    if (code === 'P0409' || code === '23505') throw new ReviewError(409, 'DECISION_CONFLICT');
    if (['22023', '23514', '22P02'].includes(code ?? '')) {
      throw new ReviewError(400, 'INVALID_REQUEST');
    }
    throw error;
  }
}

export function createDecisionRouter(): Router {
  const router = Router();
  router.use(requireAdmin);
  router.use((req, res, next) =>
    ['GET', 'HEAD'].includes(req.method) ? next() : requireAdminCsrf(req, res, next)
  );
  for (const operation of Object.keys(schemas) as (keyof typeof schemas)[]) {
    const method = ['contexts', 'audiences', 'estimate', 'list', 'report', 'detail'].includes(operation)
      ? 'get'
      : 'post';
    router[method]('/' + operation, async (req, res, next) => {
      try {
        res
          .set('Cache-Control', 'no-store')
          .json(
            await decisionCommand(
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
