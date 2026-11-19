import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { getApiKeyEncryptionSecret } from '../../config/secrets';
import { retryDeadlockedTransaction } from '../../db/client';
import { DeviceAttestationService } from '../../services/deviceAttestation';
import { encryptSensitiveValue } from '../../services/secretEncryption';
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
    biometricTemplate: z.string().min(16).max(8192).optional(),
    docPortraitBase64: z.string().max(1_500_000).optional(),
    selfieBase64: z.string().max(1_500_000).optional(),
  })
  .strict();

async function evaluateInHouseFaceMatch(
  selfieBase64: string,
  docPortraitBase64: string
): Promise<{ evaluated: boolean; score?: number; error?: string }> {
  const cleanSelfie = selfieBase64.trim().replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  const cleanDoc = docPortraitBase64.trim().replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (cleanSelfie.length < 128 || cleanDoc.length < 128) {
    return { evaluated: false };
  }
  const urls = [
    process.env.BIOMETRIC_SERVICE_URL?.trim(),
    'http://127.0.0.1:18000',
    'http://127.0.0.1:8001',
    'http://127.0.0.1:8000',
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
      };
      if (body.error) {
        return { evaluated: true, score: 0, error: body.error };
      }
      if (Array.isArray(body.faces_detected) && (body.faces_detected[0] === 0 || body.faces_detected[1] === 0)) {
        return { evaluated: true, score: 0, error: 'FACE_NOT_DETECTED' };
      }
      if (typeof body.score === 'number' && Number.isFinite(body.score)) {
        const clamped = Math.max(0, Math.min(0.999, Number(body.score.toFixed(3))));
        return { evaluated: true, score: clamped };
      }
    } catch {
      // Try next local biometric endpoint
    }
  }
  return { evaluated: false };
}

const reauthBiometricSchema = z
  .object({
    livenessScore: z.number().min(0).max(1),
    faceMatchScore: z.number().min(0).max(1),
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
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, 'status', JSON.stringify({})]
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
      const nonce = randomBytes(24).toString('hex');
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
          att.verdict === 'MEETS_STRONG'
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
      if (process.env.NODE_ENV !== 'production' && parsed.idToken.startsWith('dev-google-sub:')) {
        subject = parsed.idToken;
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
        const info = (await infoRes.json()) as { aud?: string; sub?: string; email_verified?: string };
        if (!info.aud || !allowedClientIds.has(info.aud) || !info.sub || info.email_verified !== 'true') {
          throw new ReviewError(401, 'INVALID_GOOGLE_TOKEN');
        }
        subject = info.sub;
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
            JSON.stringify({ googleSubHash }),
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

      let effectiveFaceMatchScore = parsed.faceMatchScore;
      if (parsed.selfieBase64 && rawPortrait.length >= 128) {
        const matchEval = await evaluateInHouseFaceMatch(parsed.selfieBase64, rawPortrait);
        if (matchEval.evaluated && typeof matchEval.score === 'number') {
          effectiveFaceMatchScore = matchEval.score;
        }
      }

      const result = await retryDeadlockedTransaction(async (client) => {
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
              biometricTemplateCipher,
              biometricTemplateDigest,
              portraitCipher,
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

  router.post('/biometric/reauth', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = reauthBiometricSchema.parse(req.body);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_m4_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'verify_reauth',
            JSON.stringify(parsed),
          ]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
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
