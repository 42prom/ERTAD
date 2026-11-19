import { Router, raw } from 'express';
import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { transaction } from '../../db/client';
import { SecurityService } from '../../services/security';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from '../governance/reviews';

const uuid = z.string().uuid();
const scope = z.object({ organizationId: uuid, workId: uuid });
const schemas = {
  list: scope.strict(),
  upload: scope.extend({ key: uuid }).strict(),
  download: scope.extend({ id: uuid }).strict(),
};
export function validateEvidence(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || body.length < 1 || body.length > 65536)
    throw new ReviewError(400, 'INVALID_TEXT_REPORT');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ReviewError(400, 'INVALID_TEXT_REPORT');
  }
  if (!text.trim()) throw new ReviewError(400, 'INVALID_TEXT_REPORT');
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159))
      throw new ReviewError(400, 'INVALID_TEXT_REPORT');
  }
  return body;
}
export function evidenceObjectKey(org: string, id: string, kind = 'report') {
  if (kind === 'material') return `work-materials/${org}/${id}.bin`;
  return `work-evidence/${org}/${id}.txt`;
}
export interface EvidenceStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export function createEvidenceStore(
  env: NodeJS.ProcessEnv = process.env,
  maxBytes = 65536
): EvidenceStore {
  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY)
    throw new Error('Private evidence storage unavailable');
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: env.ERTAD_EVIDENCE_ENDPOINT ?? `http://127.0.0.1:${env.ERTAD_STORAGE_PORT ?? 19000}`,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
  const Bucket = 'ertad-attachments';
  return {
    async put(Key, Body) {
      await client.send(
        new PutObjectCommand({ Bucket, Key, Body, ContentType: 'application/octet-stream' }),
        { abortSignal: AbortSignal.timeout(5000) }
      );
    },
    async get(Key) {
      const response = await client.send(new GetObjectCommand({ Bucket, Key }), {
        abortSignal: AbortSignal.timeout(5000),
      });
      if (!response.Body || !response.ContentLength || response.ContentLength > maxBytes)
        throw new Error('Evidence size mismatch');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) {
          (response.Body as { destroy?: () => void }).destroy?.();
          throw new Error('Evidence size mismatch');
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    async delete(Key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key }), {
        abortSignal: AbortSignal.timeout(5000),
      });
    },
  };
}
type Identity = Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>;
export async function evidenceTransaction(
  session: Identity,
  op: string,
  input: any,
  effect?: (data: any) => Promise<unknown>,
  material = false
) {
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const params = [
        session.sessionId,
        session.sessionTokenHash,
        op,
        input.organizationId,
        JSON.stringify(input),
      ];
      const run = async () =>
        (
          await client.query(
            material
              ? 'SELECT ertad.work_material_file_command($1,$2,$3,$4,$5) AS result'
              : 'SELECT ertad.work_evidence_command($1,$2,$3,$4,$5) AS result',
            params
          )
        ).rows[0].result;
      const first = await run();
      const bytes = effect ? await effect(first.data) : undefined;
      await SecurityService.logAuditEventInTransaction(
        client,
        material ? 'WORK_MATERIAL_FILE' : 'WORK_EVIDENCE',
        first.audit
      );
      const last = await run();
      return { data: last.data, bytes };
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0409' || code === '23505') throw new ReviewError(409, 'EVIDENCE_CONFLICT');
    if (['22023', '23514', '23502'].includes(code ?? ''))
      throw new ReviewError(400, 'INVALID_MATERIAL_FILE');
    throw error;
  }
}
export async function evidenceUpload(
  session: Identity,
  input: unknown,
  body: unknown,
  store: EvidenceStore
) {
  const parsed = schemas.upload.safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const bytes = validateEvidence(body),
    digest = createHash('sha256').update(bytes).digest('hex');
  const args = { ...parsed.data, digest, bytes: bytes.length };
  const reserved = (await evidenceTransaction(session, 'reserve', args)).data;
  // A durable pending reservation survives storage/audit failures for bounded cleanup.
  // The shared lock is held across storage publication, audit and final authority check.
  await evidenceTransaction(session, 'reserve', args, async (current) => {
    if (current.state !== 'ready')
      await store.put(evidenceObjectKey(args.organizationId, current.id), bytes);
  });
  await evidenceTransaction(session, 'ready', { ...parsed.data, id: reserved.id });
  return { id: reserved.id };
}
export async function evidenceDownload(session: Identity, input: unknown, store: EvidenceStore) {
  const parsed = schemas.download.safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const result = await evidenceTransaction(session, 'download', parsed.data, async (record) => {
    const bytes = await store.get(evidenceObjectKey(parsed.data.organizationId, record.id));
    if (
      bytes.length !== record.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== record.digest
    )
      throw new Error('Evidence integrity check failed');
    return validateEvidence(bytes);
  });
  return result.bytes as Buffer;
}
export async function evidenceList(session: Identity, input: unknown) {
  const parsed = schemas.list.safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  return (await evidenceTransaction(session, 'list', parsed.data)).data;
}
export function createEvidenceRouter(storeFactory = createEvidenceStore): Router {
  const router = Router();
  let store: EvidenceStore | undefined;
  const storage = () => (store ??= storeFactory());
  router.use(requireAdmin);
  router.get('/', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(await evidenceList(req.adminSession!, req.query));
    } catch (e) {
      next(e);
    }
  });
  router.post(
    '/',
    requireAdminCsrf,
    raw({ type: 'text/plain', limit: 65536, inflate: false }),
    async (req, res, next) => {
      try {
        res
          .status(201)
          .json(await evidenceUpload(req.adminSession!, req.query, req.body, storage()));
      } catch (e) {
        next(e);
      }
    }
  );
  router.get('/download', async (req, res, next) => {
    try {
      const bytes = await evidenceDownload(req.adminSession!, req.query, storage());
      res
        .set({
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="task-report.txt"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
        })
        .send(bytes);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
