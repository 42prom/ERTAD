import { Router } from 'express';
import { z } from 'zod';
import { retryDeadlockedTransaction } from '../../db/client';
import { SecurityService } from '../../services/security';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { publishRealtimeSignal } from '../communication/realtime';

const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);
const organization = z.object({ organizationId: uuid });
const schemas = {
  contexts: z.object({}).strict(),
  list: organization
    .extend({
      page: z.coerce.number().int().min(1).max(1000).default(1),
      view: z.enum(['pending', 'mine', 'history']).default('pending'),
      status: z.enum(['', 'pending', 'approved', 'rejected', 'expired']).default(''),
      search: z.string().max(80).default(''),
      unitId: uuid.optional(),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
    })
    .strict(),
  detail: organization.extend({ id: uuid }).strict(),
  changeOptions: organization.extend({ membershipId: uuid }).strict(),
  revisionOptions: organization.extend({
    positionId: uuid,
    page: z.coerce.number().int().min(1).max(1000).default(1),
    search: z.string().max(120).default(''),
  }).strict(),
  change: organization
    .extend({
      key: uuid,
      membershipId: uuid,
      version: z.number().int().min(0),
      kind: z.enum(['transfer', 'revoke', 'suspend', 'resume', 'revision']),
      definitionKey: z.string().regex(/^[a-f0-9]{32}$/).optional(),
      positionId: uuid.optional(),
      validUntil: z.string().datetime({ offset: true }).optional(),
      reason,
      expiresAt: z.string().datetime({ offset: true }),
    })
    .strict()
    .refine((v) =>
      v.kind === 'revision'
        ? v.positionId !== undefined && v.definitionKey !== undefined && v.validUntil === undefined
        : v.definitionKey === undefined && (v.kind === 'transfer'
        ? v.positionId !== undefined && v.validUntil !== undefined
        : v.positionId === undefined && v.validUntil === undefined)
    ),
  propose: organization
    .extend({
      key: uuid,
      targetId: uuid,
      positionId: uuid,
      reason,
      validUntil: z.string().datetime({ offset: true }),
      expiresAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  decide: organization
    .extend({ id: uuid, key: uuid, decision: z.enum(['approved', 'rejected']), reason })
    .strict(),
  notifications: organization.strict(),
  read: organization.extend({ id: uuid }).strict(),
};
export type ReviewOperation = keyof typeof schemas;
export class ReviewError extends Error {
  readonly isOperational = true;
  constructor(
    readonly statusCode: number,
    readonly code: string
  ) {
    super(code);
  }
}

/** Uses only the restricted runtime pool; no role-name or caller identity claims. */
export async function reviewCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: ReviewOperation,
  input: unknown
): Promise<any> {
  const parsed = schemas[operation].safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const args = parsed.data;
  const org = 'organizationId' in args ? args.organizationId : null;
  try {
    const out = await retryDeadlockedTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const response = (
        await client.query(`SELECT ertad.membership_review_command($1,$2,$3,$4,$5) AS result`, [
          session.sessionId,
          session.sessionTokenHash,
          operation,
          org,
          JSON.stringify(args),
        ])
      ).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'MEMBERSHIP_REVIEW', response.audit);
      await client.query('SELECT ertad.review_identity($1,$2,$3)', [
        session.sessionId,
        session.sessionTokenHash,
        ['propose', 'decide', 'change'].includes(operation),
      ]);
      if (response.audit.changed) {
        await client.query('SELECT ertad.review_finish($1,$2,$3,$4)', [
          session.sessionId,
          session.sessionTokenHash,
          org,
          response.audit.reviewId,
        ]);
      } else {
        // Reads and idempotent retries must not return a stale authorization
        // projection if an authority deadline passed during audit persistence.
        return (
          await client.query('SELECT ertad.membership_review_command($1,$2,$3,$4,$5) AS result', [
            session.sessionId,
            session.sessionTokenHash,
            operation,
            org,
            JSON.stringify(args),
          ])
        ).rows[0].result.data;
      }
      return response.data;
    });
    if (['propose', 'decide', 'change'].includes(operation)) {
      publishRealtimeSignal({
        topic: 'review',
        organizationId: org ?? undefined,
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

export function createReviewRouter(): Router {
  const router = Router();
  router.use(requireAdmin);
  router.use((req, res, next) =>
    ['GET', 'HEAD'].includes(req.method) ? next() : requireAdminCsrf(req, res, next)
  );
  for (const [method, path, operation] of [
    ['get', '/contexts', 'contexts'],
    ['get', '/', 'list'],
    ['get', '/detail', 'detail'],
    ['get', '/notifications', 'notifications'],
    ['post', '/', 'propose'],
    ['post', '/decision', 'decide'],
    ['post', '/read', 'read'],
    ['get', '/change-options', 'changeOptions'],
    ['get', '/revision-options', 'revisionOptions'],
    ['post', '/changes', 'change'],
  ] as const) {
    router[method](path, async (req, res, next) => {
      try {
        const session = req.adminSession!;
        res.json(await reviewCommand(session, operation, method === 'get' ? req.query : req.body));
      } catch (error) {
        next(error);
      }
    });
  }
  return router;
}
