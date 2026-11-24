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
      verification: z.enum(['all', 'verified', 'unverified']).default('all'),
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
            livenessScore?: number | null;
            faceMatchScore?: number | null;
            verifiedAt?: string | null;
            portraitCipher?: string | null;
            documentCount?: number;
            activeDeviceCount?: number;
            linkedGoogleCount?: number;
            documents?: Array<{
              id: string;
              documentKind?: 'eid_card' | 'passport' | 'other';
              documentFingerprint?: string;
              issuingCountry?: string;
              sodCscaVerified?: boolean;
              livenessScore?: number | null;
              faceMatchScore?: number | null;
              portraitCipher?: string | null;
              selfieCipher?: string | null;
              documentNumberCipher?: string | null;
              personalNumberCipher?: string | null;
              legalNameCipher?: string | null;
              dateOfBirthCipher?: string | null;
              createdAt?: string;
            }>;
            verificationLog?: Array<{
              id: string;
              sessionKind?: 'enrollment' | 'reauth';
              status?: string;
              sodCscaVerified?: boolean;
              livenessScore?: number | null;
              faceMatchScore?: number | null;
              createdAt?: string;
            }>;
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
          const decryptText = (cipher?: string | null): string | null => {
            if (!cipher) return null;
            try {
              const dec = decryptSensitiveValue(cipher);
              return dec ? dec : null;
            } catch {
              return null;
            }
          };
          const docs = Array.isArray(raw.documents)
            ? raw.documents.map((doc) => {
                const rawDocPortrait = decryptText(doc.portraitCipher);
                const docPortraitDataUrl =
                  rawDocPortrait && rawDocPortrait.length >= 16
                    ? `data:image/jpeg;base64,${rawDocPortrait}`
                    : null;
                const rawSelfie = decryptText(doc.selfieCipher);
                const selfieDataUrl =
                  rawSelfie && rawSelfie.length >= 16
                    ? `data:image/jpeg;base64,${rawSelfie}`
                    : null;
                return {
                  id: doc.id,
                  documentKind: doc.documentKind ?? 'eid_card',
                  documentFingerprint: doc.documentFingerprint ?? '',
                  issuingCountry: doc.issuingCountry ?? '',
                  sodCscaVerified: doc.sodCscaVerified === true,
                  livenessScore:
                    typeof doc.livenessScore === 'number' ? doc.livenessScore : null,
                  faceMatchScore:
                    typeof doc.faceMatchScore === 'number' ? doc.faceMatchScore : null,
                  portraitDataUrl: docPortraitDataUrl,
                  selfieDataUrl,
                  documentNumber: decryptText(doc.documentNumberCipher),
                  personalNumber: decryptText(doc.personalNumberCipher),
                  legalName: decryptText(doc.legalNameCipher),
                  dateOfBirth: decryptText(doc.dateOfBirthCipher),
                  createdAt: doc.createdAt ?? '',
                };
              })
            : [];
          if (portraitDataUrl || docs.some((d) => d.portraitDataUrl)) {
            await SecurityService.logAuditEventInTransaction(client, 'MEMBER_PORTRAIT_VIEWED', {
              organizationId: args.organizationId,
              targetMemberId: args.memberId,
              documentCount: docs.length,
            });
          }
          data.verification = {
            assuranceLevel: raw.assuranceLevel ?? 'google_scoped',
            citizenshipCountry: raw.citizenshipCountry ?? '',
            sodCscaVerified: raw.sodCscaVerified === true,
            livenessScore:
              typeof raw.livenessScore === 'number' ? raw.livenessScore : null,
            faceMatchScore:
              typeof raw.faceMatchScore === 'number' ? raw.faceMatchScore : null,
            verifiedAt: raw.verifiedAt ?? null,
            portraitDataUrl,
            documentCount:
              typeof raw.documentCount === 'number' ? raw.documentCount : docs.length,
            activeDeviceCount:
              typeof raw.activeDeviceCount === 'number' ? raw.activeDeviceCount : 0,
            linkedGoogleCount:
              typeof raw.linkedGoogleCount === 'number' ? raw.linkedGoogleCount : 0,
            documents: docs,
            verificationLog: Array.isArray(raw.verificationLog) ? raw.verificationLog : [],
          };
        }
        const p360 = await client.query<{ p: Record<string, unknown> | null }>(
          'SELECT ertad.member_directory_profile_360($1,$2,$3,$4) AS p',
          [
            session.sessionId,
            session.sessionTokenHash,
            args.organizationId,
            args.memberId,
          ]
        );
        if (p360.rows[0]?.p) {
          const profile = { ...p360.rows[0].p };
          let fullPhone: string | null = null;
          if (typeof profile.phoneCipher === 'string' && profile.phoneCipher.length > 0) {
            try {
              fullPhone = decryptSensitiveValue(profile.phoneCipher) || null;
            } catch {
              fullPhone = null;
            }
          }
          delete profile.phoneCipher;
          profile.phoneNumber = fullPhone ?? (typeof profile.phoneHint === 'string' ? profile.phoneHint : '');
          data.profile360 = profile;
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
