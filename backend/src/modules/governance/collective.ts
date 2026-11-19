import { createHash } from 'node:crypto';
import { Router, raw } from 'express';
import { z } from 'zod';
import { transaction } from '../../db/client';
import { SecurityService } from '../../services/security';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from './reviews';
import { publishRealtimeSignal } from '../communication/realtime';
import { createEvidenceStore, type EvidenceStore } from '../work/evidence';
import {
  materialFormat,
  MAX_MATERIAL_BYTES,
  normalizeMaterial,
} from '../work/attachmentNormalizer';

const uuid = z.string().uuid(),
  amount = z.string().regex(/^[1-9][0-9]{0,10}$/);
const org = z.object({ organizationId: uuid });
const request = org.extend({ key: uuid });
const transition = request.extend({ id: uuid, version: z.number().int().positive() });
const reason = z.string().trim().min(3).max(1000);
const proposal = request.extend({ unitId: uuid, reason, deadline: z.string().datetime() });
const funding = proposal.extend({ workId: uuid });
const positionDefinition = z.object({
  name: z.string().trim().min(1).max(120),
  grants: z.array(z.object({ permission: z.string().min(1).max(40), scope: z.enum(['unit', 'subtree']) }).strict()).min(1).max(30),
}).strict();
const kinds = [
  proposal.extend({ kind: z.literal('account_invite'), parameters: z.object({ contactId: uuid }).strict() }).strict(),
  proposal.extend({ kind: z.literal('position_retire'), parameters: z.object({ sourceId: uuid, sourceVersion: z.number().int().min(0).max(999999999), sourceName: z.string().min(1).max(120) }).strict() }).strict(),
  proposal.extend({ kind: z.literal('position_create'), parameters: positionDefinition }).strict(),
  proposal.extend({ kind: z.literal('position_revision'), parameters: positionDefinition.extend({ sourceId: uuid, sourceVersion: z.number().int().min(0) }).strict() }).strict(),
  proposal
    .extend({
      kind: z.literal('points_rule'),
      parameters: z
        .object({
          category: z.enum([
            'task',
            'vote',
            'survey',
            'manual',
            'referral_join',
            'referral_verified',
            'referral_l2_verified',
          ]),
          ruleVersion: z.number().int().min(0),
          enabled: z.boolean(),
          amount: z.number().int().min(1).max(100000),
          memberMonthCap: z.number().int().min(1).max(1000000),
          issuerMonthCap: z.number().int().min(1).max(1000000),
          templateId: uuid.optional(),
          title: z.string().trim().min(3).max(100).optional(),
          allowedUnitId: uuid.optional(),
        })
        .strict(),
    })
    .strict(),
  proposal
    .extend({
      kind: z.literal('points_award'),
      parameters: z
        .object({
          memberId: uuid,
          ruleId: uuid,
          amount: z.number().int().min(1).max(100000),
          activityId: uuid.optional(),
        })
        .strict(),
    })
    .strict(),
  proposal
    .extend({ kind: z.literal('points_reverse'), parameters: z.object({ entryId: uuid }).strict() })
    .strict(),
  proposal
    .extend({
      kind: z.literal('directive'),
      parameters: z
        .object({
          title: z.string().trim().min(3).max(160),
          body: z.string().trim().min(3).max(3000),
        })
        .strict(),
    })
    .strict(),
  proposal
    .extend({
      kind: z.literal('policy'),
      parameters: z
        .object({
          policyVersion: z.number().int().min(0),
          method: z.enum(['fixed', 'majority', 'supermajority', 'unanimous']),
          minimum: z.number().int().min(1).max(20),
        })
        .strict(),
    })
    .strict(),
  funding
    .extend({
      kind: z.literal('funding_target'),
      parameters: z
        .object({
          amount,
          currency: z.enum(['GEL', 'USD', 'EUR']),
          purpose: z.string().trim().min(3).max(500),
          targetVersion: z.number().int().min(0),
        })
        .strict(),
    })
    .strict(),
  funding
    .extend({
      kind: z.literal('funding_receipt'),
      attachmentId: uuid.optional(),
      parameters: z
        .object({
          amount,
          externalRef: z.string().trim().min(3).max(120),
          memberId: uuid,
          pledgeId: uuid.optional(),
        })
        .strict(),
    })
    .strict(),
  funding
    .extend({
      kind: z.literal('funding_expense'),
      attachmentId: uuid.optional(),
      parameters: z
        .object({
          amount,
          referenceId: uuid.optional(),
          externalRef: z.string().trim().min(3).max(120),
        })
        .strict(),
    })
    .strict(),
  funding
    .extend({ kind: z.literal('funding_reserve'), parameters: z.object({ amount }).strict() })
    .strict(),
  funding
    .extend({
      kind: z.literal('funding_release'),
      parameters: z.object({ amount, referenceId: uuid }).strict(),
    })
    .strict(),
  funding
    .extend({
      kind: z.literal('funding_refund'),
      parameters: z
        .object({ amount, referenceId: uuid, externalRef: z.string().trim().min(3).max(120) })
        .strict(),
    })
    .strict(),
  funding
    .extend({
      kind: z.literal('funding_reverse'),
      parameters: z.object({ amount, referenceId: uuid }).strict(),
    })
    .strict(),
  funding
    .extend({
      kind: z.literal('funding_envelope'),
      parameters: z.object({ amount, childId: uuid }).strict(),
    })
    .strict(),
  funding
    .extend({ kind: z.literal('funding_publish'), parameters: z.object({}).strict() })
    .strict(),
] as const;
const schemas = {
  position_contexts: z.object({}).strict(),
  positions: org.extend({ unitId: uuid.optional(), search: z.string().trim().max(120).default(''), page: z.coerce.number().int().min(1).max(1000).default(1), includeGrants: z.enum(['true','false']).optional().transform(v => v === undefined ? undefined : v === 'true') }).strict(),
  recognition: org.extend({ workId: uuid }).strict(),
  point_contexts: z.object({}).strict(),
  points: org
    .extend({
      unitId: uuid.optional(),
      memberId: uuid.optional(),
      entryId: uuid.optional(),
      page: z.coerce.number().int().min(1).max(1000).default(1),
    })
    .strict(),
  contexts: z.object({}).strict(),
  units: org.strict(),
  list: org
    .extend({
      page: z.coerce.number().int().min(1).max(1000).default(1),
      view: z.enum(['pending', 'mine', 'inbox', 'history']).default('pending'),
      workId: uuid.optional(),
    })
    .strict(),
  detail: org.extend({ id: uuid }).strict(),
  propose: z.discriminatedUnion('kind', kinds),
  vote: transition.extend({ choice: z.enum(['approve', 'reject']), reason }).strict(),
  withdraw: transition.strict(),
  ack: org.extend({ id: uuid, version: z.number().int().positive() }).strict(),
  funding: org.extend({ workId: uuid }).strict(),
  pledge: request.extend({ workId: uuid, amount }).strict(),
  withdraw_pledge: request.extend({ workId: uuid, pledgeId: uuid }).strict(),
};
export type CollectiveOperation = keyof typeof schemas;
const reads = [
  'position_contexts',
  'positions',
  'contexts',
  'units',
  'list',
  'detail',
  'funding',
  'points',
  'point_contexts',
  'recognition',
];
export async function collectiveCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: CollectiveOperation,
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
      const response = (
        await client.query('SELECT ertad.collective_command($1,$2,$3,$4,$5) AS result', params)
      ).rows[0].result;
      await SecurityService.logAuditEventInTransaction(
        client,
        'COLLECTIVE_COMMAND',
        response.audit
      );
      if (reads.includes(operation))
        return (
          await client.query('SELECT ertad.collective_command($1,$2,$3,$4,$5) AS result', params)
        ).rows[0].result.data;
      await client.query('SELECT ertad.collective_finish($1,$2,$3,$4,$5,$6)', [
        ...params,
        response.audit.changed,
      ]);
      return response.data;
    });
    if (!reads.includes(operation)) {
      publishRealtimeSignal({
        topic: 'collective',
        organizationId: 'organizationId' in args ? args.organizationId : undefined,
      });
    }
    return out;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    if (code === 'P0409' || code === '23505') throw new ReviewError(409, 'COLLECTIVE_CONFLICT');
    if (
      ['22023', '23514', '22P02', '22007', '22008', '23502', '23503', '22003'].includes(code ?? '')
    )
      throw new ReviewError(400, 'INVALID_REQUEST');
    throw error;
  }
}
const attachmentUploadSchema = org.extend({ unitId: uuid, key: uuid }).strict();
const attachmentDownloadSchema = org.extend({ attachmentId: uuid }).strict();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const collectiveObjectKey = (orgId: string, id: string) =>
  `collective-files/${orgId}/${id}.bin`;

async function collectiveAttachmentDb(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  op: 'attachment_reserve' | 'attachment_ready' | 'attachment_download',
  args: Record<string, unknown>,
  onCommit?: (record: any) => Promise<Buffer | void>
) {
  const params = [
    session.sessionId,
    session.sessionTokenHash,
    op,
    args.organizationId,
    JSON.stringify(args),
  ];
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const sql = 'SELECT ertad.collective_command($1,$2,$3,$4,$5) AS result';
      const first = (await client.query(sql, params)).rows[0].result;
      await SecurityService.logAuditEventInTransaction(
        client,
        'COLLECTIVE_COMMAND',
        first.audit
      );
      const current = (await client.query(sql, params)).rows[0].result;
      const bytes = onCommit ? await onCommit(current.data) : undefined;
      return { data: current.data, bytes };
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    if (code === 'P0409' || code === '23505') throw new ReviewError(409, 'COLLECTIVE_CONFLICT');
    if (['22023', '23514', '22P02', '23502'].includes(code ?? ''))
      throw new ReviewError(400, 'INVALID_REQUEST');
    throw error;
  }
}

export async function collectiveAttachmentUpload(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  input: unknown,
  body: unknown,
  contentType: string,
  store: EvidenceStore
) {
  const parsed = attachmentUploadSchema.safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const scope = parsed.data;
  const format = materialFormat(body, contentType);
  const bytes = body as Buffer;
  const reserveArgs = {
    ...scope,
    sourceDigest: digest(bytes),
    bytes: bytes.length,
    mediaType: format === 'pdf' ? 'application/pdf' : 'image/png',
  };
  const reserved = (await collectiveAttachmentDb(session, 'attachment_reserve', reserveArgs)).data;
  if (reserved.state === 'ready') return { id: reserved.id, mediaType: reserveArgs.mediaType };
  const normalized = await normalizeMaterial(bytes, format);
  await collectiveAttachmentDb(session, 'attachment_reserve', reserveArgs, async (current) => {
    if (current.state !== 'ready') {
      await store.put(collectiveObjectKey(scope.organizationId, current.id), normalized);
    }
  });
  return (
    await collectiveAttachmentDb(session, 'attachment_ready', {
      ...reserveArgs,
      attachmentId: reserved.id,
      digest: digest(normalized),
      bytes: normalized.length,
    })
  ).data;
}

export async function collectiveAttachmentDownload(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  input: unknown,
  store: EvidenceStore
) {
  const parsed = attachmentDownloadSchema.safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const args = parsed.data;
  const result = await collectiveAttachmentDb(session, 'attachment_download', args, async (record) => {
    const rawBytes = await store.get(collectiveObjectKey(args.organizationId, record.id));
    if (rawBytes.length !== record.bytes || digest(rawBytes) !== record.digest) {
      throw new Error('Collective attachment integrity check failed');
    }
    materialFormat(rawBytes, record.mediaType);
    return rawBytes;
  });
  return { bytes: result.bytes as Buffer, mediaType: result.data.mediaType as string };
}

export function createCollectiveRouter(
  storeFactory = () => createEvidenceStore(process.env, MAX_MATERIAL_BYTES)
): Router {
  const router = Router();
  let store: EvidenceStore | undefined;
  const storage = () => (store ??= storeFactory());
  router.use(requireAdmin);
  router.use((req, res, next) =>
    ['GET', 'HEAD'].includes(req.method) ? next() : requireAdminCsrf(req, res, next)
  );
  for (const op of Object.keys(schemas) as CollectiveOperation[]) {
    const method = reads.includes(op) ? 'get' : 'post';
    router[method]('/' + op, async (req, res, next) => {
      try {
        res
          .set('Cache-Control', 'no-store')
          .json(
            await collectiveCommand(req.adminSession!, op, method === 'get' ? req.query : req.body)
          );
      } catch (error) {
        next(error);
      }
    });
  }
  router.post(
    '/attachment',
    raw({
      type: ['image/png', 'image/jpeg', 'application/pdf'],
      limit: MAX_MATERIAL_BYTES,
      inflate: false,
    }),
    async (req, res, next) => {
      try {
        res
          .set('Cache-Control', 'no-store')
          .status(201)
          .json(
            await collectiveAttachmentUpload(
              req.adminSession!,
              req.query,
              req.body,
              req.get('content-type')?.split(';')[0] ?? '',
              storage()
            )
          );
      } catch (error) {
        next(error);
      }
    }
  );
  router.get('/attachment/download', async (req, res, next) => {
    try {
      const file = await collectiveAttachmentDownload(req.adminSession!, req.query, storage());
      res
        .set({
          'Cache-Control': 'no-store',
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="funding-evidence.${file.mediaType === 'application/pdf' ? 'pdf' : 'png'}"`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
        })
        .send(file.bytes);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
