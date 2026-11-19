import { Router, raw } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createEvidenceStore,
  evidenceObjectKey,
  evidenceTransaction,
  type EvidenceStore,
} from './evidence';
import { materialFormat, normalizeMaterial, MAX_MATERIAL_BYTES } from './attachmentNormalizer';
import { ReviewError } from '../governance/reviews';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
type Identity = Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>;
const scope = z.object({ organizationId: z.string().uuid(), workId: z.string().uuid() });
const schemas = {
  list: scope.strict(),
  upload: scope.extend({ key: z.string().uuid() }).strict(),
  file: scope.extend({ id: z.string().uuid() }).strict(),
};
function parse(schema: z.ZodType, input: unknown): any {
  const result = schema.safeParse(input);
  if (!result.success) throw new ReviewError(400, 'INVALID_REQUEST');
  return result.data;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function materialFileList(session: Identity, input: unknown) {
  return (await evidenceTransaction(session, 'list', parse(schemas.list, input), undefined, true))
    .data;
}
export async function materialFileUpload(
  session: Identity,
  input: unknown,
  body: unknown,
  type: string,
  store: EvidenceStore
) {
  const scope = parse(schemas.upload, input),
    format = materialFormat(body, type),
    bytes = body as Buffer;
  const args = {
    ...scope,
    sourceDigest: digest(bytes),
    bytes: bytes.length,
    mediaType: format === 'pdf' ? 'application/pdf' : 'image/png',
  };
  const reserved = (await evidenceTransaction(session, 'reserve', args, undefined, true)).data;
  if (reserved.state === 'ready') return { id: reserved.id };
  const normalized = await normalizeMaterial(bytes, format);
  await evidenceTransaction(
    session,
    'reserve',
    args,
    async (current) => {
      if (current.state !== 'ready')
        await store.put(
          evidenceObjectKey(scope.organizationId, current.id, 'material'),
          normalized
        );
    },
    true
  );
  await evidenceTransaction(
    session,
    'ready',
    { ...args, id: reserved.id, digest: digest(normalized), bytes: normalized.length },
    undefined,
    true
  );
  return { id: reserved.id };
}
export async function materialFileDownload(
  session: Identity,
  input: unknown,
  store: EvidenceStore
) {
  const args = parse(schemas.file, input);
  const result = await evidenceTransaction(
    session,
    'download',
    args,
    async (record) => {
      const bytes = await store.get(evidenceObjectKey(args.organizationId, record.id, 'material'));
      if (bytes.length !== record.bytes || digest(bytes) !== record.digest)
        throw new Error('Material integrity check failed');
      materialFormat(bytes, record.mediaType);
      return bytes;
    },
    true
  );
  return { bytes: result.bytes as Buffer, mediaType: result.data.mediaType as string };
}
export async function materialFileRemove(session: Identity, input: unknown) {
  return (await evidenceTransaction(session, 'remove', parse(schemas.file, input), undefined, true))
    .data;
}
export function createMaterialFilesRouter(
  storeFactory = () => createEvidenceStore(process.env, MAX_MATERIAL_BYTES)
) {
  const router = Router();
  let store: EvidenceStore | undefined;
  const storage = () => (store ??= storeFactory());
  router.use(requireAdmin);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/', async (req, res, next) => {
    try {
      res.json(await materialFileList(req.adminSession!, req.query));
    } catch (e) {
      next(e);
    }
  });
  router.post(
    '/',
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
            await materialFileUpload(
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
  router.post('/remove', requireAdminCsrf, async (req, res, next) => {
    try {
      await materialFileRemove(req.adminSession!, req.body);
      res.json({ removed: true });
    } catch (e) {
      next(e);
    }
  });
  router.get('/download', async (req, res, next) => {
    try {
      const file = await materialFileDownload(req.adminSession!, req.query, storage());
      res
        .set({
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="task-material.${file.mediaType === 'application/pdf' ? 'pdf' : 'png'}"`,
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
