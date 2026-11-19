import { Router } from 'express';
import { z } from 'zod';
import { retryDeadlockedTransaction } from '../../db/client';
import { decryptSensitiveValue } from '../../services/secretEncryption';
import { SecurityService } from '../../services/security';
import { requireAdmin } from '../../middleware/auth';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from '../governance/reviews';

const uuid = z.string().uuid();
const page = z.coerce.number().int().min(1).max(1000).default(1);
const org = z.object({ organizationId: uuid });
const schemas = {
  contexts: z.object({}).strict(),
  units: org.extend({ page, search: z.string().trim().max(120).default('') }).strict(),
  list: org
    .extend({
      page,
      unitId: uuid.optional(),
      search: z.string().trim().max(120).default(''),
      role: z.string().trim().max(120).default(''),
      status: z
        .enum(['all', 'active', 'suspended', 'ended', 'expired', 'scheduled', 'inactive'])
        .default('active'),
    })
    .strict(),
  detail: org.extend({ memberId: uuid, unitId: uuid.optional(), page }).strict(),
};
export async function memberDirectoryCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: keyof typeof schemas,
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
    return await retryDeadlockedTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const read = async () =>
        (await client.query('SELECT ertad.member_directory_command($1,$2,$3,$4,$5) result', params))
          .rows[0].result;
      const first = await read();
      await SecurityService.logAuditEventInTransaction(
        client,
        'MEMBER_DIRECTORY_READ',
        first.audit
      );
      const data = (await read()).data;
      if (
        operation === 'detail' &&
        data &&
        typeof data === 'object' &&
        'organizationId' in args &&
        'memberId' in args
      ) {
        const vq = await client.query<{
          v: {
            assuranceLevel?: string;
            citizenshipCountry?: string;
            sodCscaVerified?: boolean;
            verifiedAt?: string | null;
            portraitCipher?: string | null;
          } | null;
        }>(
          'SELECT ertad.member_directory_verification_summary($1,$2,$3,$4) AS v',
          [
            session.sessionId,
            session.sessionTokenHash,
            args.organizationId,
            args.memberId,
          ]
        );
        const raw = vq.rows[0]?.v ?? null;
        if (raw) {
          let portraitDataUrl: string | null = null;
          if (raw.portraitCipher) {
            try {
              const dec = decryptSensitiveValue(raw.portraitCipher);
              if (dec && dec.length >= 16) {
                portraitDataUrl = `data:image/jpeg;base64,${dec}`;
              }
            } catch {
              portraitDataUrl = null;
            }
          }
          data.verification = {
            assuranceLevel: raw.assuranceLevel ?? 'google_scoped',
            citizenshipCountry: raw.citizenshipCountry ?? '',
            sodCscaVerified: raw.sodCscaVerified === true,
            verifiedAt: raw.verifiedAt ?? null,
            portraitDataUrl,
          };
        }
      }
      return data;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (['22023', '22P02'].includes(code ?? '')) throw new ReviewError(400, 'INVALID_REQUEST');
    throw error;
  }
}
export function createMemberDirectoryRouter(): Router {
  const router = Router();
  router.use(requireAdmin);
  for (const operation of Object.keys(schemas) as (keyof typeof schemas)[])
    router.get('/' + operation, async (req, res, next) => {
      try {
        res
          .set('Cache-Control', 'no-store')
          .json(await memberDirectoryCommand(req.adminSession!, operation, req.query));
      } catch (error) {
        next(error);
      }
    });
  return router;
}
