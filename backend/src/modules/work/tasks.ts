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
const org = z.object({ organizationId: uuid });
const id = org.extend({ id: uuid });
const transition = id.extend({
  key: uuid,
  version: z.number().int().positive(),
  note: z.string().trim().max(1000).default(''),
});
const member = transition.extend({ memberId: uuid }).strict();
const materialUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (
      !/^https?:\/\//.test(value) ||
      /[\s\\]/.test(value) ||
      [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return false;
    try {
      const url = new URL(value);
      return !!url.hostname && !url.username && !url.password;
    } catch {
      return false;
    }
  });
const definition = {
  unitId: uuid,
  title: z.string().trim().min(3).max(160),
  description: z.string().max(3000).default(''),
  roleLabel: z.string().trim().min(1).max(100),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  capacity: z.number().int().min(1).max(100),
  deadline: z.string().datetime(),
  startsAt: z.string().datetime().nullable().optional(),
  location: z.string().trim().max(300).optional(),
  contributionRuleId: uuid.nullable().optional(),
};
const schemas = {
  event_list: org
    .extend({
      page: z.coerce.number().int().min(1).max(1000).default(1),
      status: z.enum(['open', 'completed', 'cancelled']).default('open'),
      search: z.string().max(80).default(''),
      unitId: uuid.optional(),
    })
    .strict(),
  event_detail: id.strict(),
  event_create: org
    .extend({
      key: uuid,
      unitId: uuid,
      title: z.string().trim().min(3).max(160),
      description: z.string().max(3000).default(''),
      location: z.string().trim().max(300).default(''),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      contributionRuleId: uuid.nullable(),
      capacityLimit: z.number().int().min(1).max(5000).nullable().optional(),
    })
    .strict(),
  event_complete: transition.strict(),
  event_cancel: transition.extend({ cancelLinkedTasks: z.boolean().optional() }).strict(),
  event_edit: transition
    .extend({
      title: z.string().trim().min(3).max(160),
      description: z.string().max(3000),
      location: z.string().trim().max(300),
      startsAt: z.string().datetime({ offset: true }),
      endsAt: z.string().datetime({ offset: true }),
      note: z.string().trim().min(3).max(1000),
      capacityLimit: z.number().int().min(1).max(5000).nullable().optional(),
    })
    .strict(),
  event_rsvp: id
    .extend({
      key: uuid,
      action: z.enum(['rsvp', 'cancel']),
    })
    .strict(),
  event_checkin: id
    .extend({
      key: uuid,
      checkinCode: z.string().trim().min(6).max(24),
    })
    .strict(),
  event_clone: id
    .extend({
      key: uuid,
      startsAt: z.string().datetime({ offset: true }),
      endsAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  contexts: z.object({}).strict(),
  units: org.strict(),
  overview: org.extend({ unitId: uuid.optional() }).strict(),
  list: org
    .extend({
      page: z.coerce.number().int().min(1).max(1000).default(1),
      view: z
        .enum([
          'offered',
          'open',
          'completed',
          'cancelled',
          'mine',
          'inbox',
          'blocked',
          'overdue',
          'needs_review',
          'shortfalls',
        ])
        .default('open'),
      search: z.string().max(80).default(''),
      unitId: uuid.optional(),
    })
    .strict(),
  report: org
    .extend({
      view: z
        .enum([
          'all',
          'open',
          'offered',
          'completed',
          'cancelled',
          'blocked',
          'overdue',
          'needs_review',
          'shortfalls',
        ])
        .default('all'),
      search: z.string().max(80).default(''),
      unitId: uuid.optional(),
    })
    .strict(),
  detail: id.strict(),
  edit: transition
    .extend({
      title: definition.title,
      description: z.string().max(3000),
      priority: definition.priority,
      capacity: definition.capacity,
      deadline: z.string().datetime({ offset: true }),
      startsAt: z.string().datetime({ offset: true }).nullable(),
      location: z.string().trim().max(300),
      note: z.string().trim().min(3).max(1000),
    })
    .strict(),
  materials: transition
    .extend({
      links: z
        .array(
          z
            .object({
              title: z.string().trim().min(1).max(120),
              url: materialUrl,
            })
            .strict()
        )
        .max(10),
    })
    .strict(),
  create: org.extend({ key: uuid, ...definition, eventId: uuid.optional() }).strict(),
  delegate: transition.extend({ ...definition, needId: uuid.optional() }).strict(),
  accept: transition.extend({ capacity: z.number().int().min(1).max(100) }).strict(),
  decline: transition.strict(),
  cancel: transition.strict(),
  complete: transition.strict(),
  apply: transition.extend({ needId: uuid.optional() }).strict(),
  reserve: member,
  assign: member,
  reject: member,
  withdraw: transition.strict(),
  start: transition.strict(),
  progress: transition.extend({ progress: z.number().int().min(0).max(100) }).strict(),
  submit: transition.strict(),
  return: member,
  verify: member,
  no_show: member,
  coordinator: member,
  criteria: transition
    .extend({
      criteria: z
        .array(
          z
            .object({
              id: uuid,
              title: z.string().trim().min(3).max(160),
              weight: z.number().int().min(1).max(100),
            })
            .strict()
        )
        .min(1)
        .max(10),
    })
    .strict(),
  criterion_submit: transition.extend({ criterionId: uuid }).strict(),
  criterion_verify: transition.extend({ criterionId: uuid }).strict(),
  criterion_return: transition.extend({ criterionId: uuid }).strict(),
  block: transition
    .extend({
      kind: z.enum(['people', 'resource', 'service', 'funding', 'dependency', 'other']),
      memberId: uuid.optional(),
      nextReviewAt: z.string().datetime(),
    })
    .strict(),
  resolve_block: transition.extend({ blockerId: uuid }).strict(),
  block_update: transition
    .extend({ blockerId: uuid, memberId: uuid, nextReviewAt: z.string().datetime() })
    .strict(),
  qualification_define: transition.extend({ title: z.string().trim().min(3).max(100) }).strict(),
  qualification_claim: transition
    .extend({ qualificationId: uuid, reference: z.string().trim().min(3).max(500) })
    .strict(),
  qualification_verify: transition
    .extend({ claimId: uuid, validUntil: z.string().datetime() })
    .strict(),
  qualification_reject: transition.extend({ claimId: uuid }).strict(),
  qualification_revoke: transition.extend({ claimId: uuid }).strict(),
  need_create: transition
    .extend({
      kind: z.enum(['people', 'resource', 'service']),
      title: z.string().trim().min(3).max(160),
      quantity: z.string().regex(/^[0-9]{1,7}(\.[0-9]{1,3})?$/),
      unitLabel: z.string().trim().min(1).max(40),
      gate: z.enum(['optional', 'start', 'complete']),
      memberId: uuid,
      deadline: z.string().datetime(),
      qualificationIds: z.array(uuid).max(10).default([]),
    })
    .strict(),
  need_cancel: transition.extend({ needId: uuid }).strict(),
  provision_offer: transition
    .extend({ needId: uuid, quantity: z.string().regex(/^[0-9]{1,7}(\.[0-9]{1,3})?$/) })
    .strict(),
  provision_confirm: transition.extend({ provisionId: uuid }).strict(),
  provision_withdraw: transition.extend({ provisionId: uuid }).strict(),
  provision_return: transition.extend({ provisionId: uuid }).strict(),
  provision_reject: transition.extend({ provisionId: uuid }).strict(),
  ack: id.extend({ version: z.number().int().positive() }).strict(),
};
export type WorkOperation = keyof typeof schemas;
export async function workCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: WorkOperation,
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
  const mutation = ![
    'contexts',
    'units',
    'list',
    'report',
    'detail',
    'overview',
    'event_list',
    'event_detail',
  ].includes(operation);
  try {
    const out = await retryDeadlockedTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const response = (
        await client.query('SELECT ertad.work_command($1,$2,$3,$4,$5) AS result', params)
      ).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'WORK_COMMAND', response.audit);
      if (mutation) {
        await client.query('SELECT ertad.work_finish($1,$2,$3,$4,$5,$6)', [
          ...params,
          response.audit.changed,
        ]);
        return response.data;
      }
      return (await client.query('SELECT ertad.work_command($1,$2,$3,$4,$5) AS result', params))
        .rows[0].result.data;
    });
    if (mutation) {
      publishRealtimeSignal({
        topic: operation.startsWith('event_') ? 'event' : 'work',
        organizationId: organization ?? undefined,
      });
    }
    return out;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    if (code === 'P0409' || code === '23505') throw new ReviewError(409, 'WORK_CONFLICT');
    if (['22023', '23514', '22P02', '22007', '22008', '23502'].includes(code ?? ''))
      throw new ReviewError(400, 'INVALID_REQUEST');
    throw error;
  }
}
export function createWorkRouter(): Router {
  const router = Router();
  router.use(requireAdmin);
  router.use((req, res, next) =>
    ['GET', 'HEAD'].includes(req.method) ? next() : requireAdminCsrf(req, res, next)
  );
  for (const operation of Object.keys(schemas) as WorkOperation[]) {
    const method = [
      'contexts',
      'units',
      'list',
      'report',
      'detail',
      'overview',
      'event_list',
      'event_detail',
    ].includes(operation)
      ? 'get'
      : 'post';
    router[method]('/' + operation, async (req, res, next) => {
      try {
        res
          .set('Cache-Control', 'no-store')
          .json(
            await workCommand(req.adminSession!, operation, method === 'get' ? req.query : req.body)
          );
      } catch (error) {
        next(error);
      }
    });
  }
  return router;
}
