import { createHash, randomBytes } from 'node:crypto';
import { requireProviderAccess } from '../../modules/security/providerPolicy';
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { query, retryDeadlockedTransaction } from '../../db/client';
import { createError, createErrorWithCode } from '../../middleware/errorHandler';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import { createLoginLimits, requestSecurityLimits } from '../../modules/security/securityLimits';
import {
  clearAdminSessionCookie,
  createAdminSession,
  revokeAdminSession,
  readAdminCsrf,
} from '../../services/adminSession';
import { SecurityService } from '../../services/security';
import { matchMfaCounter } from '../../services/adminMfa';
import { decryptSensitiveValue } from '../../services/secretEncryption';
import { createSelfAccountRouter } from '../../modules/identity/selfAccount';
import { rpIdFromOrigin, verifyAssertionSignature } from '../../services/webauthn';

const STEP_UP_MINUTES = 5;
const DUMMY_PASSWORD_HASH = '$2b$12$Um4WyJZrlplY5cCDZRslk.lHr.Ph6JLkGygl1XYG1TEQNOwhN3Y0u';

type LoginUser = {
  password_hash: string;
  mfaProof?: { encryptedSecret: string; counter: number };
  id: string;
  email: string;
  role: 'superadmin' | 'admin' | 'moderator' | 'observer';
  full_name: string | null;
};

export function createAdminAuthRouter({
  requireMfa = true,
  allowedOrigins = ['http://localhost:15173', 'http://127.0.0.1:15173'],
}: { requireMfa?: boolean; allowedOrigins?: string[] } = {}) {
  if (!requireMfa && !['development', 'test'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('Password-only administrator access is restricted to local development/tests');
  }
  const router = Router();
  router.use('/security', createSelfAccountRouter(allowedOrigins));

  /** POST /api/v1/admin/auth/login */
  router.post(
    '/login',
    createLoginLimits(),
    requireProviderAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const email =
          typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const totpCode = typeof req.body?.totpCode === 'string' ? req.body.totpCode.trim() : '';

        if (!email || email.length > 255 || !password || password.length > 1024) {
          res.locals.securitySignal = 'login_failed';
          throw createError('Invalid credentials', 401);
        }

        let enrollmentRequired = false;
        const authenticatedUser = await retryDeadlockedTransaction<LoginUser | null>(async (client) => {
          const result = await client.query(
            `SELECT id, email, password_hash, role, full_name, is_active,
                failed_login_attempts, locked_until, mfa_secret_encrypted, mfa_enabled, mfa_last_counter
           FROM admin_users
          WHERE lower(email) = $1
          FOR UPDATE`,
            [email]
          );
          const user = result.rows[0];

          if (!user) {
            await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
            return null;
          }

          const passwordValid = await bcrypt.compare(password, user.password_hash);
          const locked = user.locked_until && new Date(user.locked_until).getTime() > Date.now();
          let mfaValid = !requireMfa;
          let mfaCounter: number | null = null;
          if (requireMfa && passwordValid && user.is_active && !locked) {
            if (user.mfa_secret_encrypted) {
              try {
                if (/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(totpCode.toUpperCase())) {
                  const recoveryHash = createHash('sha256')
                    .update(totpCode.toUpperCase())
                    .digest('hex');
                  const usedRecovery = (
                    await client.query('SELECT ertad.consume_mfa_recovery($1,$2) AS ok', [
                      user.id,
                      recoveryHash,
                    ])
                  ).rows[0]?.ok;
                  mfaValid = !!usedRecovery;
                } else {
                  mfaCounter = matchMfaCounter(
                    decryptSensitiveValue(user.mfa_secret_encrypted),
                    totpCode
                  );
                  mfaValid = mfaCounter !== null && mfaCounter > Number(user.mfa_last_counter);
                }
              } catch {
                mfaValid = false;
              }
            } else {
              enrollmentRequired = true;
              mfaValid = false;
            }
          }

          if (!passwordValid || !user.is_active || locked || !mfaValid) {
            if ((!passwordValid || !mfaValid) && !enrollmentRequired && user.is_active && !locked) {
              await client.query(
                `UPDATE admin_users
                SET failed_login_attempts = LEAST(failed_login_attempts + 1, 1000),
                    locked_until = CASE
                      WHEN failed_login_attempts + 1 >= $2
                        THEN NOW() + ($3 * INTERVAL '1 minute')
                      ELSE locked_until
                    END,
                    updated_at = NOW()
              WHERE id = $1`,
                [user.id, requestSecurityLimits(res).loginFailures, requestSecurityLimits(res).lockoutMinutes]
              );
            }
            return null;
          }

          await client.query(
            `UPDATE admin_users
            SET last_login_at = NOW(), failed_login_attempts = 0,
                locked_until = NULL,
                mfa_enabled = CASE WHEN $2::bigint IS NOT NULL THEN true ELSE mfa_enabled END,
                mfa_enrolled_at = CASE
                  WHEN $2::bigint IS NOT NULL THEN COALESCE(mfa_enrolled_at, NOW())
                  ELSE mfa_enrolled_at
                END,
                mfa_last_counter = COALESCE($2, mfa_last_counter), updated_at = NOW()
          WHERE id = $1`,
            [user.id, mfaCounter]
          );

          if (mfaCounter !== null && !user.mfa_enabled) {
            await SecurityService.logAuditEventInTransaction(client, 'ADMIN_MFA_ENROLLED', {
              adminUserId: user.id,
            });
            const valid = await client.query(
              `SELECT 1 FROM admin_users WHERE id=$1 AND password_hash=$2 AND is_active
               AND (locked_until IS NULL OR locked_until<=clock_timestamp())
               AND mfa_enabled AND mfa_secret_encrypted=$3 AND mfa_last_counter=$4`,
              [user.id, user.password_hash, user.mfa_secret_encrypted, mfaCounter]
            );
            if (!valid.rowCount) throw createErrorWithCode('CREDENTIAL_CHANGED', 'Sign in again', 401);
          }

          return {
            password_hash: user.password_hash,
            ...(mfaCounter === null ? {} : {
              mfaProof: { encryptedSecret: user.mfa_secret_encrypted, counter: mfaCounter },
            }),
            id: user.id,
            email: user.email,
            role: user.role,
            full_name: user.full_name,
          };
        });

        if (!authenticatedUser) {
          await SecurityService.logAuditEventStrict('ADMIN_LOGIN_FAILED', {
            reason: 'invalid_credentials',
          });
          if (enrollmentRequired) {
            throw createErrorWithCode(
              'MFA_ENROLLMENT_REQUIRED',
              'This admin account must be provisioned with MFA before login',
              403
            );
          }
          res.locals.securitySignal = 'login_failed';
          throw createError('Invalid credentials', 401);
        }

        const csrfToken = await createAdminSession(authenticatedUser.id, req, res, authenticatedUser.password_hash, authenticatedUser.email, authenticatedUser.mfaProof);

        res.setHeader('Cache-Control', 'no-store');
        res.json({
          csrfToken,
          user: {
            id: authenticatedUser.id,
            email: authenticatedUser.email,
            role: authenticatedUser.role,
            fullName: authenticatedUser.full_name || undefined,
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /** GET /api/v1/admin/auth/me */
  router.get('/me', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.adminUser || !req.adminSession) {
        throw createError('Not authenticated', 401);
      }
      const csrfToken = await readAdminCsrf(req.adminSession.sessionId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        csrfToken,
        user: req.adminUser,
      });
    } catch (error) {
      next(error);
    }
  });

  /** POST /api/v1/admin/auth/step-up */
  router.post(
    '/step-up',
    requireAdmin,
    requireAdminCsrf,
    requireProviderAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.adminUser || !req.adminSession) throw createError('Not authenticated', 401);
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const totpCode = typeof req.body?.totpCode === 'string' ? req.body.totpCode.trim() : '';
        if (!password || password.length > 1024) throw createError('Invalid credentials', 401);

        const expiresAt = await retryDeadlockedTransaction<Date | null>(async (client) => {
          // Technical reads lock session then account. Keep the same order during
          // password verification so a simultaneous refresh cannot deadlock step-up.
          const activeSession = await client.query(
            `SELECT id FROM admin_sessions WHERE id=$1 AND admin_user_id=$2 AND token_hash=$3
             AND revoked_at IS NULL AND idle_expires_at>clock_timestamp()
             AND absolute_expires_at>clock_timestamp() FOR UPDATE`,
            [req.adminSession!.sessionId, req.adminUser!.id, req.adminSession!.sessionTokenHash]
          );
          if (!activeSession.rows[0]) return null;
          const result = await client.query(
            `SELECT password_hash, is_active, locked_until, mfa_secret_encrypted, mfa_last_counter, mfa_enabled
             FROM admin_users WHERE id = $1 FOR UPDATE`,
            [req.adminUser!.id]
          );
          const user = result.rows[0];
          if (!user) return null;

          const passwordValid = await bcrypt.compare(password, user.password_hash);
          const locked = user.locked_until && new Date(user.locked_until).getTime() > Date.now();
          let mfaValid = !requireMfa;
          let mfaCounter: number | null = null;
          if (requireMfa && user.mfa_enabled && user.mfa_secret_encrypted) {
            try {
              mfaCounter = matchMfaCounter(
                decryptSensitiveValue(user.mfa_secret_encrypted),
                totpCode
              );
              mfaValid = mfaCounter !== null && mfaCounter > Number(user.mfa_last_counter);
            } catch {
              mfaValid = false;
            }
          }

          if (!passwordValid || !mfaValid || !user.is_active || locked) {
            if (user.is_active && !locked) {
              await client.query(
                `UPDATE admin_users
                  SET failed_login_attempts = LEAST(failed_login_attempts + 1, 1000),
                      locked_until = CASE
                        WHEN failed_login_attempts + 1 >= $2
                          THEN NOW() + ($3 * INTERVAL '1 minute')
                        ELSE locked_until
                      END,
                      updated_at = NOW()
                WHERE id = $1`,
                [req.adminUser!.id, requestSecurityLimits(res).loginFailures, requestSecurityLimits(res).lockoutMinutes]
              );
            }
            return null;
          }

          await client.query(
            `UPDATE admin_users
              SET failed_login_attempts = 0, locked_until = NULL, mfa_last_counter = COALESCE($2, mfa_last_counter), updated_at = NOW()
            WHERE id = $1`,
            [req.adminUser!.id, mfaCounter]
          );
          const session = await client.query(
            `UPDATE admin_sessions
              SET step_up_expires_at = LEAST(
                    absolute_expires_at,
                    NOW() + ($3 * INTERVAL '1 minute')
                  )
            WHERE id = $1 AND admin_user_id = $2 AND revoked_at IS NULL
              AND idle_expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp()
            RETURNING step_up_expires_at`,
            [req.adminSession!.sessionId, req.adminUser!.id, STEP_UP_MINUTES]
          );
          if (!session.rows[0]) return null;

          await SecurityService.logAuditEventInTransaction(client, 'ADMIN_STEP_UP_GRANTED', {
            adminUserId: req.adminUser!.id,
            session: req.adminSession!.sessionTokenHash.slice(0, 16),
          });
          return new Date(session.rows[0].step_up_expires_at);
        });

        if (!expiresAt) {
          await SecurityService.logAuditEventStrict('ADMIN_STEP_UP_FAILED', {
            adminUserId: req.adminUser.id,
            session: req.adminSession.sessionTokenHash.slice(0, 16),
          });
          res.locals.securitySignal = 'step_up_failed';
          throw createError('Invalid credentials', 401);
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json({ expiresAt: expiresAt.toISOString() });
      } catch (error) {
        next(error);
      }
    }
  );

  /** POST /api/v1/admin/auth/logout */
  router.post(
    '/logout',
    requireAdmin,
    requireAdminCsrf,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.adminSession || !req.adminUser) {
          throw createError('Not authenticated', 401);
        }
        await revokeAdminSession(req.adminSession.sessionId);
        clearAdminSessionCookie(res);
        await SecurityService.logAuditEventStrict('ADMIN_LOGOUT', {
          adminUserId: req.adminUser.id,
          session: req.adminSession.sessionTokenHash.slice(0, 16),
        });
        res.setHeader('Clear-Site-Data', '"cache"');
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    }
  );

  const passkeyVerifyBodySchema = z
    .object({
      challengeId: z.string().uuid(),
      credentialId: z.string().min(16).max(512),
      clientDataJSON: z.string().min(16).max(4096),
      authenticatorData: z.string().min(32).max(4096),
      signature: z.string().min(16).max(2048),
    })
    .strict();

  router.post(
    '/passkey/login/options',
    createLoginLimits(),
    requireProviderAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const challenge = randomBytes(32).toString('base64url');
        const data = (
          await query('SELECT ertad.passkey_login_challenge($1) AS r', [challenge])
        ).rows[0].r;
        const reqOrigin = req.get('origin') || allowedOrigins[0];
        const rpId = rpIdFromOrigin(allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]);
        res.set('Cache-Control', 'no-store').json({
          challengeId: data.challengeId,
          challenge: data.challenge,
          rpId,
          timeout: 120000,
          userVerification: 'preferred',
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/passkey/login/verify',
    createLoginLimits(),
    requireProviderAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = passkeyVerifyBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.locals.securitySignal = 'login_failed';
          throw createError('Invalid credentials', 401);
        }
        const reqOrigin = req.get('origin') || allowedOrigins[0];
        const rpId = rpIdFromOrigin(allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]);

        const lookup = (
          await query('SELECT ertad.passkey_login_lookup($1,$2) AS r', [
            parsed.data.challengeId,
            parsed.data.credentialId,
          ])
        ).rows[0]?.r;
        if (!lookup) {
          res.locals.securitySignal = 'login_failed';
          throw createError('Invalid credentials', 401);
        }

        let assertion: { signCount: number };
        try {
          assertion = verifyAssertionSignature({
            clientDataJSON: parsed.data.clientDataJSON,
            authenticatorData: parsed.data.authenticatorData,
            signature: parsed.data.signature,
            expectedChallenge: lookup.challenge,
            expectedOrigins: allowedOrigins,
            rpId,
            publicKeySpki: lookup.publicKeySpki,
            algorithm: lookup.algorithm,
            previousSignCount: Number(lookup.signCount),
          });
        } catch {
          res.locals.securitySignal = 'login_failed';
          throw createError('Invalid credentials', 401);
        }

        const consumed = (
          await query('SELECT ertad.passkey_login_consume($1,$2,$3) AS ok', [
            parsed.data.challengeId,
            parsed.data.credentialId,
            assertion.signCount,
          ])
        ).rows[0]?.ok;
        if (!consumed) {
          res.locals.securitySignal = 'login_failed';
          throw createError('Invalid credentials', 401);
        }

        const csrfToken = await createAdminSession(
          lookup.adminUserId,
          req,
          res,
          lookup.passwordHash,
          lookup.email
        );

        res.setHeader('Cache-Control', 'no-store');
        res.json({
          csrfToken,
          user: {
            id: lookup.adminUserId,
            email: lookup.email,
            role: lookup.role,
            fullName: lookup.fullName || undefined,
          },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/passkey/step-up/options',
    requireAdmin,
    requireAdminCsrf,
    requireProviderAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const challenge = randomBytes(32).toString('base64url');
        const data = (
          await query('SELECT ertad.own_passkey_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'challenge_stepup',
            JSON.stringify({ challenge }),
          ])
        ).rows[0].r;
        const reqOrigin = req.get('origin') || allowedOrigins[0];
        const rpId = rpIdFromOrigin(allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]);
        res.set('Cache-Control', 'no-store').json({
          challengeId: data.challengeId,
          challenge: data.challenge,
          rpId,
          allowCredentials: (data.allowCredentialIds as string[]).map((id) => ({
            type: 'public-key',
            id,
          })),
          timeout: 120000,
          userVerification: 'preferred',
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/passkey/step-up/verify',
    requireAdmin,
    requireAdminCsrf,
    requireProviderAccess,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = passkeyVerifyBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.locals.securitySignal = 'step_up_failed';
          throw createError('Invalid credentials', 401);
        }
        const reqOrigin = req.get('origin') || allowedOrigins[0];
        const rpId = rpIdFromOrigin(allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]);

        const ok = await retryDeadlockedTransaction(async (client) => {
          const lookup = (
            await client.query('SELECT ertad.own_passkey_command($1,$2,$3,$4) AS r', [
              req.adminSession!.sessionId,
              req.adminSession!.sessionTokenHash,
              'consume_stepup',
              JSON.stringify({
                lookupOnly: true,
                challengeId: parsed.data.challengeId,
                credentialId: parsed.data.credentialId,
              }),
            ])
          ).rows[0]?.r;
          if (!lookup?.challenge) return false;

          const verified = verifyAssertionSignature({
            clientDataJSON: parsed.data.clientDataJSON,
            authenticatorData: parsed.data.authenticatorData,
            signature: parsed.data.signature,
            expectedChallenge: lookup.challenge,
            expectedOrigins: allowedOrigins,
            rpId,
            publicKeySpki: lookup.publicKeySpki,
            algorithm: lookup.algorithm,
            previousSignCount: Number(lookup.signCount),
          });
          await client.query('SELECT ertad.own_passkey_command($1,$2,$3,$4)', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'consume_stepup',
            JSON.stringify({
              challengeId: parsed.data.challengeId,
              credentialId: parsed.data.credentialId,
              nextSignCount: verified.signCount,
            }),
          ]);
          await SecurityService.logAuditEventInTransaction(client, 'ADMIN_STEP_UP_GRANTED', {
            adminUserId: req.adminUser!.id,
            session: req.adminSession!.sessionTokenHash.slice(0, 16),
            method: 'passkey',
          });
          return true;
        });

        if (!ok) {
          res.locals.securitySignal = 'step_up_failed';
          throw createError('Invalid credentials', 401);
        }
        res.set('Cache-Control', 'no-store').json({
          expiresAt: new Date(Date.now() + STEP_UP_MINUTES * 60_000).toISOString(),
        });
      } catch (error) {
        res.locals.securitySignal = 'step_up_failed';
        next(createError('Invalid credentials', 401));
      }
    }
  );

  return router;
}

// Retained security-test/production-facing composition remains MFA-required.
export default createAdminAuthRouter();
