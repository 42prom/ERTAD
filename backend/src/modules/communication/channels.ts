import { createHash, createHmac } from 'node:crypto';
import { Router, raw } from 'express';
import { z } from 'zod';
import { transaction } from '../../db/client';
import { SecurityService } from '../../services/security';
import { getApiKeyEncryptionSecret } from '../../config/secrets';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from '../governance/reviews';
import { publishRealtimeSignal } from './realtime';
import { createEvidenceStore, type EvidenceStore } from '../work/evidence';
import {
  materialFormat,
  MAX_MATERIAL_BYTES,
  normalizeMaterial,
} from '../work/attachmentNormalizer';
const uuid = z.string().uuid(),
  org = z.object({ organizationId: uuid }),
  id = org.extend({ id: uuid }),
  write = id.extend({ key: uuid });
const page = z.coerce.number().int().min(1).max(1000).default(1);
const schemas = {
  restriction: org.extend({ restrictionId: uuid }).strict(),
  restrictions: org
    .extend({ page, view: z.enum(['pending', 'mine', 'history']).default('pending') })
    .strict(),
  restrict: write
    .extend({
      messageId: uuid,
      reason: z.string().trim().min(10).max(1000),
      expiresAt: z.string().datetime(),
    })
    .strict(),
  appeal: write
    .extend({
      restrictionId: uuid,
      version: z.number().int().positive(),
      reason: z.string().trim().min(10).max(1000),
    })
    .strict(),
  'review-appeal': write
    .extend({
      restrictionId: uuid,
      version: z.number().int().positive(),
      reason: z.string().trim().min(10).max(1000),
      outcome: z.enum(['uphold', 'lift']),
    })
    .strict(),
  work: org.extend({ workId: uuid }).strict(),
  'work-create': org.extend({ workId: uuid, key: uuid }).strict(),
  contexts: z.object({}).strict(),
  units: org.extend({ page }).strict(),
  list: org
    .extend({
      page,
      view: z.enum(['active', 'archived', 'unread']).default('active'),
      kind: z.enum(['all', 'group', 'global', 'task', 'direct', 'member_all']).optional(),
    })
    .strict(),
  thread: id.extend({ before: z.coerce.number().int().min(0).max(2147483647).default(0) }).strict(),
  create: org
    .extend({
      key: uuid,
      unitId: uuid,
      title: z.string().trim().min(3).max(120),
      kind: z.enum(['group', 'global']).optional(),
    })
    .strict(),
  'direct-peers': org.strict(),
  'direct-open': org.extend({ key: uuid, peerId: uuid }).strict(),
  'direct-block': id.extend({ key: uuid, blocked: z.boolean() }).strict(),
  post: write
    .extend({
      body: z.string().trim().min(1).max(4000),
      replyId: uuid.optional(),
      attachmentId: uuid.optional(),
    })
    .strict(),
  react: write
    .extend({
      messageId: uuid,
      emoji: z.enum(['like', 'confirm', 'heart', 'eyes', 'celebrate']),
    })
    .strict(),
  pin: write.extend({ messageId: uuid.nullable() }).strict(),
  search: id.extend({ search: z.string().trim().min(1).max(80) }).strict(),
  participants: id.strict(),
  read: write.extend({ seq: z.number().int().min(0).max(2147483647) }).strict(),
  mute: write.extend({ muted: z.boolean() }).strict(),
  archive: write.extend({ version: z.number().int().positive(), archived: z.boolean() }).strict(),
  remove: write.extend({ messageId: uuid }).strict(),
  report: write
    .extend({ messageId: uuid, category: z.enum(['spam', 'abuse', 'privacy', 'other']) })
    .strict(),
  reports: id.extend({ page }).strict(),
  resolve: write.extend({ reportId: uuid, outcome: z.enum(['keep', 'remove']) }).strict(),
};
export type ChannelOperation = keyof typeof schemas;
export async function channelCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  op: ChannelOperation,
  input: unknown
): Promise<any> {
  const parsed = schemas[op].safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const args = parsed.data;
  // A keyed standard digest allows exact retry validation without copying private text into receipts.
  const fingerprint = createHmac('sha256', getApiKeyEncryptionSecret())
    .update('ertad-channel-retry-v1\0' + op + '\0' + JSON.stringify(args))
    .digest('hex');
  const params = [
    session.sessionId,
    session.sessionTokenHash,
    op,
    'organizationId' in args ? args.organizationId : null,
    JSON.stringify(args),
    fingerprint,
  ];
  try {
    const out = await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const sql = 'SELECT ertad.channel_command($1,$2,$3,$4,$5,$6) AS result';
      const result = (await client.query(sql, params)).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'CHANNEL_COMMAND', result.audit);
      // Re-evaluate authority after audit; idempotent mutations cannot duplicate messages.
      return (await client.query(sql, params)).rows[0].result.data;
    });
    if (
      [
        'create',
        'post',
        'archive',
        'remove',
        'resolve',
        'restrict',
        'appeal',
        'review-appeal',
        'react',
        'pin',
        'direct-open',
        'direct-block',
      ].includes(op)
    ) {
      publishRealtimeSignal({
        topic: 'channel',
        organizationId: 'organizationId' in args ? args.organizationId : undefined,
        channelId: 'id' in args ? args.id : undefined,
      });
    }
    return out;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    if (code === 'P0409' || code === '23505') throw new ReviewError(409, 'CHANNEL_CONFLICT');
    if (code === 'P0429') throw new ReviewError(429, 'CHANNEL_RATE_LIMIT');
    if (['22023', '22P02', '23514', '23502'].includes(code ?? ''))
      throw new ReviewError(400, 'INVALID_REQUEST');
    throw error;
  }
}
const attachmentUploadSchema = write.strict();
const attachmentDownloadSchema = id.extend({ attachmentId: uuid }).strict();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const channelObjectKey = (org: string, channelId: string, id: string) =>
  `channel-files/${org}/${channelId}/${id}.bin`;

async function channelAttachmentDb(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  op: 'attachment_reserve' | 'attachment_ready' | 'attachment_download',
  args: Record<string, unknown>,
  onCommit?: (record: any) => Promise<Buffer | void>
) {
  const fingerprint = createHmac('sha256', getApiKeyEncryptionSecret())
    .update('ertad-channel-retry-v1\0' + op + '\0' + JSON.stringify(args))
    .digest('hex');
  const params = [
    session.sessionId,
    session.sessionTokenHash,
    op,
    args.organizationId,
    JSON.stringify(args),
    fingerprint,
  ];
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const sql = 'SELECT ertad.channel_command($1,$2,$3,$4,$5,$6) AS result';
      const first = (await client.query(sql, params)).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'CHANNEL_COMMAND', first.audit);
      const current = (await client.query(sql, params)).rows[0].result;
      const bytes = onCommit ? await onCommit(current.data) : undefined;
      return { data: current.data, bytes };
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    if (code === 'P0409' || code === '23505') throw new ReviewError(409, 'CHANNEL_CONFLICT');
    if (code === 'P0429') throw new ReviewError(429, 'CHANNEL_RATE_LIMIT');
    if (['22023', '22P02', '23514', '23502'].includes(code ?? ''))
      throw new ReviewError(400, 'INVALID_REQUEST');
    throw error;
  }
}

export async function channelAttachmentUpload(
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
  const reserved = (await channelAttachmentDb(session, 'attachment_reserve', reserveArgs)).data;
  if (reserved.state === 'ready') return { id: reserved.id, mediaType: reserveArgs.mediaType };
  const normalized = await normalizeMaterial(bytes, format);
  await channelAttachmentDb(session, 'attachment_reserve', reserveArgs, async (current) => {
    if (current.state !== 'ready') {
      await store.put(channelObjectKey(scope.organizationId, scope.id, current.id), normalized);
    }
  });
  const ready = (
    await channelAttachmentDb(session, 'attachment_ready', {
      ...reserveArgs,
      attachmentId: reserved.id,
      digest: digest(normalized),
      bytes: normalized.length,
    })
  ).data;
  return ready;
}

export async function channelAttachmentDownload(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  input: unknown,
  store: EvidenceStore
) {
  const parsed = attachmentDownloadSchema.safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const args = parsed.data;
  const result = await channelAttachmentDb(session, 'attachment_download', args, async (record) => {
    const rawBytes = await store.get(channelObjectKey(args.organizationId, args.id, record.id));
    if (rawBytes.length !== record.bytes || digest(rawBytes) !== record.digest) {
      throw new Error('Channel attachment integrity check failed');
    }
    materialFormat(rawBytes, record.mediaType);
    return rawBytes;
  });
  return { bytes: result.bytes as Buffer, mediaType: result.data.mediaType as string };
}

export function createChannelRouter(
  storeFactory = () => createEvidenceStore(process.env, MAX_MATERIAL_BYTES)
): Router {
  const router = Router();
  let store: EvidenceStore | undefined;
  const storage = () => (store ??= storeFactory());
  router.use(requireAdmin);
  for (const op of [
    'contexts',
    'units',
    'list',
    'thread',
    'reports',
    'work',
    'restrictions',
    'restriction',
    'search',
    'participants',
    'direct-peers',
  ] as const)
    router.get('/' + op, async (req, res, next) => {
      try {
        res.json(await channelCommand(req.adminSession!, op, req.query));
      } catch (e) {
        next(e);
      }
    });
  for (const op of [
    'restrict',
    'appeal',
    'review-appeal',
    'work-create',
    'create',
    'post',
    'read',
    'mute',
    'archive',
    'remove',
    'report',
    'resolve',
    'react',
    'pin',
    'direct-open',
    'direct-block',
  ] as const)
    router.post('/' + op, requireAdminCsrf, async (req, res, next) => {
      try {
        res.json(await channelCommand(req.adminSession!, op, req.body));
      } catch (e) {
        next(e);
      }
    });
  router.post(
    '/attachment',
    requireAdminCsrf,
    raw({
      type: ['image/png', 'image/jpeg', 'application/pdf'],
      limit: MAX_MATERIAL_BYTES,
      inflate: false,
    }),
    async (req, res, next) => {
      try {
        res
          .status(201)
          .json(
            await channelAttachmentUpload(
              req.adminSession!,
              req.query,
              req.body,
              req.get('content-type')?.split(';')[0] ?? '',
              storage()
            )
          );
      } catch (e) {
        next(e);
      }
    }
  );
  router.get('/attachment/download', async (req, res, next) => {
    try {
      const file = await channelAttachmentDownload(req.adminSession!, req.query, storage());
      res
        .set({
          'Cache-Control': 'no-store',
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="channel-attachment.${file.mediaType === 'application/pdf' ? 'pdf' : 'png'}"`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
        })
        .send(file.bytes);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
