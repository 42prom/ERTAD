import { createHmac } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { getApiKeyEncryptionSecret } from '../../config/secrets';
import { retryDeadlockedTransaction } from '../../db/client';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import { SecurityService } from '../../services/security';
import { encryptSensitiveValue } from '../../services/secretEncryption';
import { ReviewError } from '../governance/reviews';

const verificationProposalSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().min(1).max(2147483646),
    authProfile: z.enum(['google_hybrid', 'document_and_face']),
    requireDeviceAttestation: z.boolean(),
    requireNfc: z.boolean(),
    requireGeorgianCitizen: z.boolean(),
    livenessProvider: z.enum(['3d_face_detector']).default('3d_face_detector'),
    faceMatchProvider: z.enum(['custom_biometric_matcher']).default('custom_biometric_matcher'),
    livenessMinScore: z.number().min(0.3).max(0.99),
    faceMatchMinScore: z.number().min(0.15).max(0.99),
    retryLimit: z.number().int().min(1).max(10),
    biometricTtlSeconds: z.number().int().min(60).max(86400),
    apiKey: z.string().min(1).max(512).optional(),
    reason: z.enum(['security_tightening', 'provider_change', 'recovery']),
  })
  .strict();

const reviewSchema = z
  .object({
    requestId: z.string().uuid(),
    proposalId: z.string().uuid(),
    action: z.enum(['approve', 'reject', 'withdraw']),
  })
  .strict();

const deviceControlSchema = z
  .object({
    op: z.enum(['hold', 'release', 'revoke', 'purge_biometrics']),
    bindingId: z.string().uuid().optional(),
    reason: z.enum(['suspected_compromise', 'replay_detected', 'operator_request']).optional(),
  })
  .strict()
  .refine((v) => v.op === 'purge_biometrics' || Boolean(v.bindingId), {
    message: 'bindingId required for device state transitions',
  });

const integrationProposeSchema = z
  .object({
    requestId: z.string().uuid(),
    provider: z.enum(['google_oidc', 'fcm_push', 'telegram_bot', 'whatsapp_business', 'viber_bot']),
    expectedVersion: z.number().int().min(1),
    enabled: z.boolean(),
    publicConfig: z.record(z.string(), z.string().max(256)).default({}),
    secret: z.string().trim().max(4096).optional(),
    clearSecret: z.boolean().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

const integrationReviewSchema = z
  .object({
    requestId: z.string().uuid(),
    proposalId: z.string().uuid(),
    action: z.enum(['approve', 'reject']),
  })
  .strict();

function mapSqlError(error: unknown, next: NextFunction): void {
  if (error instanceof z.ZodError) {
    next(new ReviewError(400, 'INVALID_REQUEST'));
    return;
  }
  const code = (error as { code?: string })?.code;
  if (code === '42501') {
    next(new ReviewError(403, 'ACCESS_DENIED'));
    return;
  }
  if (code === 'P0428') {
    next(new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED'));
    return;
  }
  if (code === '40001' || code === '23505') {
    next(new ReviewError(409, 'POLICY_CONFLICT'));
    return;
  }
  if (code === '22023' || code === '22P02' || code === '23514') {
    next(new ReviewError(400, 'INVALID_REQUEST'));
    return;
  }
  next(error);
}

/**
 * Admin Verification & eID Biometric Infrastructure Governance Router.
 * Enforces strict separation between Read (`platform.verification.read`),
 * Two-Person Policy Control (`platform.verification.propose` / `.approve`),
 * and Mobile Device Containment (`platform.mobile_devices.control`).
 */
export function createVerificationGovernanceRouter(): Router {
  const router = Router();

  router.get('/policy', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.verification_policy_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, 'get', JSON.stringify({})]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapSqlError(error, next);
    }
  });

  router.post('/policy/propose', requireAdminCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = verificationProposalSchema.parse(req.body);
      const { apiKey, ...rest } = parsed;
      const payload = {
        ...rest,
        credentialCipher: apiKey ? encryptSensitiveValue(apiKey) : null,
        credentialDigest: apiKey
          ? createHmac('sha256', getApiKeyEncryptionSecret())
              .update(`ertad-verification-credential-v1\0${apiKey}`)
              .digest('hex')
          : null,
      };
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.verification_policy_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, 'propose', JSON.stringify(payload)]
        );
        await SecurityService.logAuditEventInTransaction(client, 'PLATFORM_VERIFICATION_PROPOSE', {
          adminUserId: session.id,
          sessionId: session.sessionId,
          expectedVersion: parsed.expectedVersion,
          authProfile: parsed.authProfile,
          reason: parsed.reason,
        });
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapSqlError(error, next);
    }
  });

  router.post('/policy/review', requireAdminCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = reviewSchema.parse(req.body);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.verification_policy_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, 'review', JSON.stringify(parsed)]
        );
        await SecurityService.logAuditEventInTransaction(client, 'PLATFORM_VERIFICATION_REVIEW', {
          adminUserId: session.id,
          sessionId: session.sessionId,
          proposalId: parsed.proposalId,
          action: parsed.action,
        });
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapSqlError(error, next);
    }
  });

  router.get('/devices', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_device_control_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, 'list', JSON.stringify({})]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapSqlError(error, next);
    }
  });

  router.post('/devices/control', requireAdminCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = deviceControlSchema.parse(req.body);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.mobile_device_control_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, parsed.op, JSON.stringify(parsed)]
        );
        await SecurityService.logAuditEventInTransaction(client, 'PLATFORM_MOBILE_DEVICE_CONTROL', {
          adminUserId: session.id,
          sessionId: session.sessionId,
          op: parsed.op,
          bindingId: parsed.bindingId ?? null,
          reason: parsed.reason ?? null,
        });
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapSqlError(error, next);
    }
  });

  router.get('/integrations', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.platform_integration_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, 'read', JSON.stringify({})]
        );
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapSqlError(error, next);
    }
  });

  router.post('/integrations/propose', requireAdminCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = integrationProposeSchema.parse(req.body);
      const secretCipher = parsed.secret ? encryptSensitiveValue(parsed.secret) : null;
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.platform_integration_command($1, $2, $3, $4) AS result',
          [
            session.sessionId,
            session.sessionTokenHash,
            'propose',
            JSON.stringify({
              requestId: parsed.requestId,
              provider: parsed.provider,
              expectedVersion: parsed.expectedVersion,
              enabled: parsed.enabled,
              publicConfig: parsed.publicConfig,
              secretCipher,
              clearSecret: Boolean(parsed.clearSecret),
              reason: parsed.reason,
            }),
          ]
        );
        await SecurityService.logAuditEventInTransaction(client, 'PLATFORM_INTEGRATION_PROPOSE', {
          adminUserId: session.id,
          sessionId: session.sessionId,
          provider: parsed.provider,
          enabled: parsed.enabled,
          hasSecretUpdate: Boolean(secretCipher),
          clearSecret: Boolean(parsed.clearSecret),
        });
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapSqlError(error, next);
    }
  });

  router.post('/integrations/review', requireAdminCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = req.adminSession!;
      const parsed = integrationReviewSchema.parse(req.body);
      const result = await retryDeadlockedTransaction(async (client) => {
        const q = await client.query<{ result: unknown }>(
          'SELECT ertad.platform_integration_command($1, $2, $3, $4) AS result',
          [session.sessionId, session.sessionTokenHash, 'review', JSON.stringify(parsed)]
        );
        await SecurityService.logAuditEventInTransaction(client, 'PLATFORM_INTEGRATION_REVIEW', {
          adminUserId: session.id,
          sessionId: session.sessionId,
          proposalId: parsed.proposalId,
          action: parsed.action,
        });
        return q.rows[0]?.result;
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      mapSqlError(error, next);
    }
  });

  return router;
}
