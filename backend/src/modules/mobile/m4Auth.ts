import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { getApiKeyEncryptionSecret } from '../../config/secrets';
import { retryDeadlockedTransaction } from '../../db/client';
import { DeviceAttestationService } from '../../services/deviceAttestation';
import { decryptSensitiveValue, encryptSensitiveValue } from '../../services/secretEncryption';
import { SecurityService } from '../../services/security';
import { ReviewError } from '../governance/reviews';

const challengeSchema = z
  .object({
    platform: z.enum(['android', 'ios']),
  })
  .strict();

const verifyAttestationSchema = z
  .object({
    platform: z.enum(['android', 'ios']),
    provider: z.enum(['play_integrity_standard', 'play_integrity', 'app_attest', 'device_check']),
    deviceId: z.string().min(8).max(128),
    appId: z.string().min(3).max(160),
    nonce: z.string().min(32).max(128),
    token: z.string().min(8).max(16384),
    counter: z.number().int().min(0).default(0),
    credentialSubject: z.string().max(128).optional(),
  })
  .strict();

const bindGoogleSchema = z
  .object({
    idToken: z.string().min(16).max(8192),
    emailHint: z.string().trim().email().max(160).optional(),
    makePrimary: z.boolean().optional(),
  })
  .strict();

const googleAccountActionSchema = z
  .object({
    accountId: z.string().uuid(),
  })
  .strict();

const completeBiometricSchema = z
  .object({
    deviceId: z.string().min(8).max(128).optional(),
    sodCscaVerified: z.boolean(),
    citizenshipCountry: z.string().trim().min(2).max(3),
    livenessScore: z.number().min(0).max(1),
    faceMatchScore: z.number().min(0).max(1),
    personSubjectKey: z.string().min(6).max(256),
    documentKind: z.enum(['eid_card', 'passport', 'other']).optional(),
    biometricTemplate: z.string().min(16).max(8192).optional(),
    docPortraitBase64: z.string().max(1_500_000).optional(),
    selfieBase64: z.string().max(1_500_000).optional(),
    documentNumber: z.string().trim().max(64).optional(),
    personalNumber: z.string().trim().max(64).optional(),
    legalName: z.string().trim().max(160).optional(),
    dateOfBirth: z.string().trim().max(32).optional(),
  })
  .strict();

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return Math.max(0, dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

function maskEmail(raw: string): string {
  const clean = raw.trim().toLowerCase();
  const at = clean.indexOf('@');
  if (at <= 0) return '';
  const local = clean.slice(0, at);
  const domain = clean.slice(at);
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***${domain}`.slice(0, 120);
}

async function evaluateInHouseFaceMatch(
  selfieBase64: string,
  docPortraitBase64: string
): Promise<{ evaluated: boolean; score?: number; embedding2?: number[]; error?: string }> {
  const cleanSelfie = selfieBase64.trim().replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  const cleanDoc = docPortraitBase64.trim().replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (cleanSelfie.length < 128 || cleanDoc.length < 128) {
    return { evaluated: false };
  }
  const urls = [
    process.env.BIOMETRIC_SERVICE_URL?.trim(),
    'http://127.0.0.1:18000',
  ].filter((u): u is string => Boolean(u));

  for (const baseUrl of urls) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/verify-normalized`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image1_base64: cleanSelfie,
          image2_base64: cleanDoc,
          normalize: true,
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        score?: number;
        error?: string;
        faces_detected?: number[];
        embedding2?: number[];
      };
      if (body.error) {
        return { evaluated: true, score: 0, error: body.error };
      }
      if (Array.isArray(body.faces_detected) && (body.faces_detected[0] === 0 || body.faces_detected[1] === 0)) {
        return { evaluated: true, score: 0, error: 'FACE_NOT_DETECTED' };
      }
      if (typeof body.score === 'number' && Number.isFinite(body.score)) {
        const clamped = Math.max(0, Math.min(0.999, Number(body.score.toFixed(3))));
        const embedding2 = Array.isArray(body.embedding2)
          ? body.embedding2.filter((v) => typeof v === 'number' && Number.isFinite(v))
          : undefined;
        return {
          evaluated: true,
          score: clamped,
          embedding2: embedding2 && embedding2.length >= 128 ? embedding2 : undefined,
        };
      }
    } catch {
      // Try next local biometric endpoint
    }
  }
  return { evaluated: false };
}

const statusQuerySchema = z
  .object({
    deviceId: z.string().min(8).max(128).optional(),
  })
  .strict();

const reauthBiometricSchema = z
  .object({
    livenessScore: z.number().min(0).max(1),
    faceMatchScore: z.number().min(0).max(1),
    deviceId: z.string().min(8).max(128).optional(),
    platform: z.enum(['android', 'ios']).optional(),
    appId: z.string().min(3).max(160).optional(),
    selfieBase64: z.string().max(1_500_000).optional(),
  })
  .strict();

const referralSummaryQuerySchema = z
  .object({
    organizationId: z.string().uuid(),
  })
  .strict();

const referralRedeemSchema = z
  .object({
    organizationId: z.string().uuid(),
    unitId: z.string().uuid().optional(),
    code: z.string().trim().min(6).max(32),
  })
  .strict();

const notificationChannelUpdateSchema = z
  .object({
    channel: z.enum(['push', 'telegram', 'whatsapp', 'viber']),
    enabled: z.boolean(),
    handle: z.string().trim().max(120).optional(),
  })
  .strict();

const memberPhoneUpdateSchema = z
  .object({
    phone: z.string().trim().regex(/^\+?[0-9\s\-()]{7,24}$/).optional(),
    clear: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.clear === true || Boolean(v.phone), {
    message: 'phone or clear required',
  });

function maskPhone(raw: string): string {
  const digits = raw.replace(/[^0-9+]/g, '');
  if (digits.length <= 5) return '****';
  return `${digits.slice(0, 5)}***${digits.slice(-2)}`;
}

function maskChannelHandle(raw?: string): string {
  const clean = (raw ?? '').trim();
  if (!clean) return '';
  if (clean.length <= 4) return '****';
  return `${clean.slice(0, 3)}***${clean.slice(-2)}`;
}

function mapM4Error(error: unknown, next: NextFunction): void {
  if (error instanceof z.ZodError) {
    next(new ReviewError(400, 'INVALID_REQUEST'));
    return;
  }
  const code = (error as { code?: string })?.code;
  if (code === '42501') {
    next(new ReviewError(403, 'ACCESS_DENIED'));
    return;
  }
  if (code === '23505') {
    next(new ReviewError(409, 'DUPLICATE_PERSON_PROOF'));
    return;
  }
  if (code === '22023' || code === '22P02' || code === '23514') {
    next(new ReviewError(400, 'INVALID_REQUEST'));
    return;
  }
  next(error);
}

/**
 * M4 Mobile Assurance Router:
 * - Hybrid Google OIDC + server-owned session assurance
 * - Replay-protected Device Attestation (`Play Integrity` / `App Attest`)
 * - eID Biometric & SOD/CSCA verification with keyed person-uniqueness & TTL purge
 */
export function createMobileM4Router(): Router {
  const router = Router();

  router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const query = statusQuerySchema.parse(req.query);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'status',
            JSON.stringify(query.deviceId ? { deviceId: query.deviceId } : {}),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/attestation/challenge', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = challengeSchema.parse(req.body);
      const nonce = randomBytes(32).toString('hex');
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'issue_challenge',
            JSON.stringify({ nonce, platform: parsed.platform }),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/attestation/verify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = verifyAttestationSchema.parse(req.body);

      const allowDevSim =
        process.env.NODE_ENV !== 'production' &&
        parsed.token.startsWith('dev-attest-') &&
        parsed.token.length >= 16;

      let mappedVerdict: 'strong' | 'basic' | 'unverified' = 'unverified';
      let keyIdHash = createHash('sha256').update(parsed.deviceId).digest('hex');

      if (allowDevSim) {
        mappedVerdict = 'strong';
        keyIdHash = createHash('sha256').update(parsed.token).digest('hex');
      } else {
        const att = await DeviceAttestationService.verify(
          parsed.platform,
          parsed.provider,
          parsed.token,
          parsed.nonce,
          parsed.credentialSubject
        );
        if (!att.success) {
          throw new ReviewError(403, 'ATTESTATION_FAILED');
        }
        mappedVerdict =
          att.verdict === 'MEETS_STRONG' || att.verdict === 'HARDWARE_BACKED'
            ? 'strong'
            : att.verdict === 'MEETS_BASIC'
              ? 'basic'
              : 'unverified';
        if (att.deviceKeyHash) {
          keyIdHash = createHash('sha256').update(att.deviceKeyHash).digest('hex');
        }
      }

      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'verify_attestation',
            JSON.stringify({
              nonce: parsed.nonce,
              deviceId: parsed.deviceId,
              platform: parsed.platform,
              appId: parsed.appId,
              keyIdHash,
              verdict: mappedVerdict,
              counter: parsed.counter,
            }),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.get('/google/config', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const q = await retryDeadlockedTransaction(async (client) => {
        const r = await client.query<{
          cfg: { enabled?: boolean; publicConfig?: Record<string, string> };
        }>('SELECT ertad.get_google_oidc_runtime_config() AS cfg');
        return r.rows[0]?.cfg;
      });
      const envClientId = process.env.GOOGLE_OIDC_CLIENT_ID?.trim() ?? '';
      const androidClientId = q?.publicConfig?.androidClientId?.trim() || envClientId;
      const iosClientId = q?.publicConfig?.iosClientId?.trim() || envClientId;
      res.set('Cache-Control', 'no-store').json({
        enabled: Boolean(q?.enabled || envClientId),
        androidClientId,
        iosClientId,
      });
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/google/bind', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = bindGoogleSchema.parse(req.body);

      // In production, require a verified Google OIDC ID token (JWT with RS256/Google tokeninfo or JWKS).
      // In non-production dev mode, allow synthetic `dev-google-sub:<id>` for local simulation.
      let subject = '';
      let emailHint = '';
      if (process.env.NODE_ENV !== 'production' && parsed.idToken.startsWith('dev-google-sub:')) {
        subject = parsed.idToken;
        emailHint = parsed.emailHint ? maskEmail(parsed.emailHint) : '';
      } else {
        const runtimeCfg = await retryDeadlockedTransaction(async (client) => {
          const r = await client.query<{
            cfg: { enabled?: boolean; publicConfig?: Record<string, string> };
          }>('SELECT ertad.get_google_oidc_runtime_config() AS cfg');
          return r.rows[0]?.cfg;
        });
        const allowedClientIds = new Set(
          [
            process.env.GOOGLE_OIDC_CLIENT_ID?.trim() ?? '',
            runtimeCfg?.publicConfig?.androidClientId?.trim() ?? '',
            runtimeCfg?.publicConfig?.iosClientId?.trim() ?? '',
          ].filter(Boolean)
        );
        if (allowedClientIds.size === 0) {
          throw new ReviewError(503, 'GOOGLE_OIDC_NOT_CONFIGURED');
        }
        const infoRes = await fetch(
          `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(parsed.idToken)}`,
          { redirect: 'error', signal: AbortSignal.timeout(5000) }
        );
        if (!infoRes.ok) {
          throw new ReviewError(401, 'INVALID_GOOGLE_TOKEN');
        }
        const info = (await infoRes.json()) as {
          aud?: string;
          sub?: string;
          email?: string;
          email_verified?: string;
        };
        if (!info.aud || !allowedClientIds.has(info.aud) || !info.sub || info.email_verified !== 'true') {
          throw new ReviewError(401, 'INVALID_GOOGLE_TOKEN');
        }
        subject = info.sub;
        emailHint = info.email ? maskEmail(info.email) : '';
      }

      const googleSubHash = createHmac('sha256', getApiKeyEncryptionSecret())
        .update(`ertad-google-sub-v1\0${subject}`)
        .digest('hex');

      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'bind_google',
            JSON.stringify({
              googleSubHash,
              emailHint,
              makePrimary: parsed.makePrimary === true,
            }),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/google/remove', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = googleAccountActionSchema.parse(req.body);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'remove_google',
            JSON.stringify({ accountId: parsed.accountId }),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/google/primary', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = googleAccountActionSchema.parse(req.body);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'set_primary_google',
            JSON.stringify({ accountId: parsed.accountId }),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/biometric/complete', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = completeBiometricSchema.parse(req.body);
      const personUniquenessHash = createHmac('sha256', getApiKeyEncryptionSecret())
        .update(`ertad-person-uniqueness-v1\0${parsed.personSubjectKey}`)
        .digest('hex');
      const biometricTemplateCipher = parsed.biometricTemplate
        ? encryptSensitiveValue(parsed.biometricTemplate)
        : null;
      const biometricTemplateDigest = parsed.biometricTemplate
        ? createHmac('sha256', getApiKeyEncryptionSecret())
            .update(`ertad-biometric-template-v1\0${parsed.biometricTemplate}`)
            .digest('hex')
        : null;
      const rawPortrait = (parsed.docPortraitBase64 ?? '')
        .trim()
        .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
      const portraitCipher =
        rawPortrait.length >= 32 ? encryptSensitiveValue(rawPortrait) : null;
      const documentKind = parsed.documentKind ?? 'eid_card';
      const documentSeed =
        rawPortrait.length >= 32
          ? createHash('sha256').update(rawPortrait).digest('hex')
          : parsed.personSubjectKey;
      const documentFingerprint = createHmac('sha256', getApiKeyEncryptionSecret())
        .update(`ertad-doc-v1\0${documentKind}\0${documentSeed}`)
        .digest('hex');

      let effectiveFaceMatchScore = parsed.faceMatchScore;
      let faceEmbeddingCipher: string | null = null;
      if (parsed.selfieBase64 && rawPortrait.length >= 128) {
        const matchEval = await evaluateInHouseFaceMatch(parsed.selfieBase64, rawPortrait);
        if (matchEval.evaluated) {
          effectiveFaceMatchScore = matchEval.error
            ? 0
            : typeof matchEval.score === 'number'
              ? matchEval.score
              : 0;
          if (!matchEval.error && Array.isArray(matchEval.embedding2) && matchEval.embedding2.length >= 128) {
            const peers = await retryDeadlockedTransaction(async (client) => {
              const q = await client.query<{
                result: Array<{ memberId: string; faceEmbeddingCipher: string }>;
              }>('SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result', [
                session.sessionId,
                session.sessionTokenHash,
                'list_peer_embeddings',
                '{}',
              ]);
              return q.rows[0]?.result ?? [];
            });
            for (const peer of peers) {
              try {
                const dec = decryptSensitiveValue(peer.faceEmbeddingCipher);
                const peerEmb = JSON.parse(dec) as unknown;
                if (
                  Array.isArray(peerEmb) &&
                  cosineSimilarity(matchEval.embedding2, peerEmb as number[]) >= 0.5
                ) {
                  await retryDeadlockedTransaction(async (client) => {
                    await client.query('SELECT ertad.mobile_m4_command($1, $2, $3, $4)', [
                      session.sessionId,
                      session.sessionTokenHash,
                      'record_failed_attempt',
                      JSON.stringify({
                        sessionKind: 'enrollment',
                        livenessScore: parsed.livenessScore,
                        faceMatchScore: effectiveFaceMatchScore,
                      }),
                    ]);
                    await SecurityService.logAuditEventInTransaction(
                      client,
                      'BIOMETRIC_DUPLICATE_FACE_BLOCKED',
                      { matchedMemberId: peer.memberId }
                    );
                  }).catch(() => {});
                  throw new ReviewError(409, 'DUPLICATE_BIOMETRIC_FACE');
                }
              } catch (err) {
                if (err instanceof ReviewError) throw err;
              }
            }
            faceEmbeddingCipher = encryptSensitiveValue(JSON.stringify(matchEval.embedding2));
          }
        } else if (
          process.env.NODE_ENV === 'production' ||
          process.env.ERTAD_REQUIRE_INHOUSE_BIOMETRIC === 'true'
        ) {
          throw new ReviewError(503, 'BIOMETRIC_SERVICE_UNAVAILABLE');
        }
      }

      const rawSelfie = (parsed.selfieBase64 ?? '')
        .trim()
        .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
      const selfieCipher =
        rawSelfie.length >= 32 ? encryptSensitiveValue(rawSelfie) : null;
      const documentNumberCipher = parsed.documentNumber
        ? encryptSensitiveValue(parsed.documentNumber)
        : null;
      const personalNumberCipher = parsed.personalNumber
        ? encryptSensitiveValue(parsed.personalNumber)
        : null;
      const legalNameCipher = parsed.legalName
        ? encryptSensitiveValue(parsed.legalName)
        : null;
      const dateOfBirthCipher = parsed.dateOfBirth
        ? encryptSensitiveValue(parsed.dateOfBirth)
        : null;

      const result = await (async () => {
        try {
          return await retryDeadlockedTransaction(async (client) => {
            const q = await client.query<{ result: unknown }>(
              'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
              [
                session.sessionId,
                session.sessionTokenHash,
                'complete_biometric',
                JSON.stringify({
                  deviceId: parsed.deviceId ?? null,
                  sodCscaVerified: parsed.sodCscaVerified,
                  citizenshipCountry: parsed.citizenshipCountry,
                  livenessScore: parsed.livenessScore,
                  faceMatchScore: effectiveFaceMatchScore,
                  personUniquenessHash,
                  documentKind,
                  documentFingerprint,
                  biometricTemplateCipher,
                  biometricTemplateDigest,
                  portraitCipher,
                  faceEmbeddingCipher,
                }),
              ]
            );
            if (
              documentNumberCipher ||
              personalNumberCipher ||
              legalNameCipher ||
              dateOfBirthCipher ||
              selfieCipher
            ) {
              await client.query(
                'SELECT ertad.mobile_m4_store_doc_claims($1, $2, $3)',
                [
                  session.sessionId,
                  session.sessionTokenHash,
                  JSON.stringify({
                    documentNumberCipher,
                    personalNumberCipher,
                    legalNameCipher,
                    dateOfBirthCipher,
                    selfieCipher,
                  }),
                ]
              );
            }
            return q.rows[0]?.result;
          });
        } catch (dbErr) {
          const msg = (dbErr as { message?: string })?.message ?? '';
          if ((dbErr as { code?: string })?.code === '42501' && msg.toLowerCase().includes('threshold')) {
            await retryDeadlockedTransaction(async (client) => {
              await client.query('SELECT ertad.mobile_m4_command($1, $2, $3, $4)', [
                session.sessionId,
                session.sessionTokenHash,
                'record_failed_attempt',
                JSON.stringify({
                  sessionKind: 'enrollment',
                  livenessScore: parsed.livenessScore,
                  faceMatchScore: effectiveFaceMatchScore,
                }),
              ]);
            }).catch(() => {});
          }
          throw dbErr;
        }
      })();
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/biometric/reauth', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = reauthBiometricSchema.parse(req.body);
      const keyIdHash = parsed.deviceId
        ? createHash('sha256').update(parsed.deviceId).digest('hex')
        : undefined;

      let effectiveFaceMatchScore = parsed.faceMatchScore;
      let faceMatchEvaluated = false;

      if (parsed.selfieBase64) {
        const ref = await retryDeadlockedTransaction(async (client) => {
          const q = await client.query<{
            result: { portraitCipher?: string | null; hasPortrait?: boolean };
          }>('SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result', [
            session.sessionId,
            session.sessionTokenHash,
            'get_reauth_reference',
            '{}',
          ]);
          return q.rows[0]?.result;
        });

        if (typeof ref?.portraitCipher === 'string' && ref.portraitCipher.length > 0) {
          const storedPortrait = decryptSensitiveValue(ref.portraitCipher);
          const matchEval = await evaluateInHouseFaceMatch(parsed.selfieBase64, storedPortrait);
          if (matchEval.evaluated) {
            faceMatchEvaluated = true;
            effectiveFaceMatchScore = matchEval.error
              ? 0
              : typeof matchEval.score === 'number'
                ? matchEval.score
                : 0;
          } else if (
            process.env.NODE_ENV === 'production' ||
            process.env.ERTAD_REQUIRE_INHOUSE_BIOMETRIC === 'true'
          ) {
            throw new ReviewError(503, 'BIOMETRIC_SERVICE_UNAVAILABLE');
          }
        }
      }

      const result = await (async () => {
        try {
          return await retryDeadlockedTransaction(async (client) => {
            const q = await client.query<{ result: Record<string, unknown> }>(
              'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
              [
                session.sessionId,
                session.sessionTokenHash,
                'verify_reauth',
                JSON.stringify({
                  livenessScore: parsed.livenessScore,
                  faceMatchScore: effectiveFaceMatchScore,
                  ...(parsed.deviceId
                    ? {
                        deviceId: parsed.deviceId,
                        platform: parsed.platform ?? 'android',
                        appId: parsed.appId ?? 'ge.ertad.mobile',
                        keyIdHash,
                        verdict: 'strong',
                        counter: Math.floor(Date.now() / 1000),
                      }
                    : {}),
                }),
              ]
            );
            return q.rows[0]?.result ?? {};
          });
        } catch (dbErr) {
          const msg = (dbErr as { message?: string })?.message ?? '';
          if ((dbErr as { code?: string })?.code === '42501' && msg.toLowerCase().includes('threshold')) {
            await retryDeadlockedTransaction(async (client) => {
              await client.query('SELECT ertad.mobile_m4_command($1, $2, $3, $4)', [
                session.sessionId,
                session.sessionTokenHash,
                'record_failed_attempt',
                JSON.stringify({
                  sessionKind: 'reauth',
                  deviceId: parsed.deviceId ?? null,
                  livenessScore: parsed.livenessScore,
                  faceMatchScore: effectiveFaceMatchScore,
                }),
              ]);
            }).catch(() => {});
          }
          throw dbErr;
        }
      })();
      res.set('Cache-Control', 'no-store').json({
        ...result,
        faceMatchEvaluated,
        faceMatchScore: effectiveFaceMatchScore,
      });
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.get('/referrals/summary', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = referralSummaryQuerySchema.parse(req.query);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_referral_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'summary',
            JSON.stringify({ organizationId: parsed.organizationId }),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/referrals/redeem', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = referralRedeemSchema.parse(req.body);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_referral_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'redeem',
            JSON.stringify({
              organizationId: parsed.organizationId,
              unitId: parsed.unitId ?? null,
              code: parsed.code,
            }),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.get('/channels', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_notification_channels_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, 'get', JSON.stringify({})]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/channels', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = notificationChannelUpdateSchema.parse(req.body);
      const handleCipher = parsed.handle ? encryptSensitiveValue(parsed.handle) : null;
      const handleHint = maskChannelHandle(parsed.handle);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_notification_channels_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'set',
            JSON.stringify({
              channel: parsed.channel,
              enabled: parsed.enabled,
              handleCipher,
              handleHint,
            }),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.get('/profile', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_profile_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, 'get', JSON.stringify({})]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  router.post('/profile/phone', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = memberPhoneUpdateSchema.parse(req.body);
      const isClear = parsed.clear === true;
      const phoneCipher = !isClear && parsed.phone ? encryptSensitiveValue(parsed.phone) : null;
      const phoneHint = !isClear && parsed.phone ? maskPhone(parsed.phone) : '';
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_profile_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'set_phone',
            JSON.stringify({
              clear: isClear,
              phoneCipher,
              phoneHint,
            }),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapM4Error(error, next);
    }
  });

  return router;
}
