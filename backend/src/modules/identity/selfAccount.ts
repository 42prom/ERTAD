import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { PoolClient } from 'pg';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { query, retryDeadlockedTransaction } from '../../db/client';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import { createErrorWithCode } from '../../middleware/errorHandler';
import { SecurityService } from '../../services/security';
import { hashAdminPassword, validateAdminPassword } from '../../services/adminPassword';
import { generateMfaSecret, matchMfaCounter, mfaProvisioningUri } from '../../services/adminMfa';
import { decryptSensitiveValue, encryptSensitiveValue } from '../../services/secretEncryption';
import { clearAdminSessionCookie, type AdminSessionIdentity } from '../../services/adminSession';
import { rpIdFromOrigin, verifyRegistrationAttestation } from '../../services/webauthn';
import { createEmailChangeRouter } from './emailChange';

type Identity = Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>;
const schemas = {
  sessions: z.object({ before: z.string().uuid().optional() }).strict(),
  revoke: z.object({ sessionId: z.string().uuid() }).strict(),
  revokeOthers: z.object({}).strict(),
  password: z.object({ newPassword: z.string().min(14).max(72) }).strict(),
  recovery: z.object({}).strict(),
  cancelRecovery: z.object({ recoveryId: z.string().uuid() }).strict(),
};
type Operation = keyof typeof schemas;
const fail = (status: number, code: string): never => {
  throw createErrorWithCode(code, code, status);
};

async function lockIdentity(client: PoolClient, identity: Identity, write: boolean) {
  const session = (
    await client.query(`SELECT * FROM admin_sessions WHERE id=$1 AND token_hash=$2 FOR UPDATE`, [
      identity.sessionId,
      identity.sessionTokenHash,
    ])
  ).rows[0];
  if (!session) return fail(401, 'SESSION_UNAVAILABLE');
  const account = (
    await client.query('SELECT * FROM admin_users WHERE id=$1 FOR UPDATE', [session.admin_user_id])
  ).rows[0];
  await client.query('SELECT pg_advisory_xact_lock(752991884322001::bigint)');
  const valid = (
    await client.query(
      `SELECT a.is_active AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())
      AND s.revoked_at IS NULL AND s.idle_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp() AS active,
      COALESCE(s.step_up_expires_at>clock_timestamp(),false) AS fresh
     FROM admin_users a JOIN admin_sessions s ON s.admin_user_id=a.id WHERE s.id=$1 AND s.token_hash=$2`,
      [identity.sessionId, identity.sessionTokenHash]
    )
  ).rows[0];
  if (!valid?.active) return fail(401, 'SESSION_UNAVAILABLE');
  if (write && !valid.fresh) return fail(428, 'STEP_UP_REQUIRED');
  return { session, account };
}

export async function selfAccountCommand(identity: Identity, operation: Operation, input: unknown) {
  const parsed = schemas[operation].safeParse(input);
  if (!parsed.success) return fail(400, 'INVALID_REQUEST');
  const args = parsed.data;
  // Hash outside the transaction; no password, hash or token is written to audit/logs.
  if ('newPassword' in args && validateAdminPassword(args.newPassword))
    return fail(400, 'PASSWORD_POLICY');
  const nextHash = 'newPassword' in args ? await hashAdminPassword(args.newPassword) : undefined;
  try {
    return await retryDeadlockedTransaction(async (client) => {
      const write = operation !== 'sessions' && operation !== 'recovery';
      const { session, account } = await lockIdentity(client, identity, write);
      let data: unknown;
      let target: string | undefined;
      let changedAt: Date | undefined;
      if (operation === 'recovery' || 'recoveryId' in args) {
        data = (
          await client.query('SELECT ertad.own_web_recovery($1,$2,$3,$4) result', [
            identity.sessionId,
            identity.sessionTokenHash,
            operation === 'recovery' ? 'read' : 'cancel',
            'recoveryId' in args ? args.recoveryId : null,
          ])
        ).rows[0].result;
      } else if ('newPassword' in args) {
        if (validateAdminPassword(args.newPassword, account.email))
          return fail(400, 'PASSWORD_POLICY');
        if (await bcrypt.compare(args.newPassword, account.password_hash))
          return fail(400, 'PASSWORD_UNCHANGED');
        changedAt = (
          await client.query('SELECT ertad.replace_own_admin_password($1,$2,$3,$4) changed_at', [
            identity.sessionId,
            identity.sessionTokenHash,
            account.password_hash,
            nextHash,
          ])
        ).rows[0].changed_at;
        data = { signedOut: true };
      } else if (operation === 'revokeOthers') {
        // Account lock serializes this cutoff with session creation. Include sessions
        // beyond the current list page, but never another account or the caller.
        const result = await client.query(
          `UPDATE admin_sessions SET revoked_at=clock_timestamp(),step_up_expires_at=NULL
           WHERE admin_user_id=$1 AND id<>$2 AND revoked_at IS NULL`,
          [account.id, identity.sessionId]
        );
        data = { revokedCount: result.rowCount ?? 0 };
      } else if ('sessionId' in args) {
        target = args.sessionId;
        if (target === identity.sessionId) return fail(400, 'USE_LOGOUT');
        // The same ID can be retried safely; it can never select somebody else's session.
        const result = await client.query(
          `UPDATE admin_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()),step_up_expires_at=NULL
           WHERE id=$1 AND admin_user_id=$2 RETURNING id,revoked_at AS "revokedAt"`,
          [target, account.id]
        );
        if (!result.rows[0]) return fail(404, 'SESSION_UNAVAILABLE');
        data = result.rows[0];
      } else {
        const rows = (
          await client.query(
            `SELECT id,id=$2 AS current,client_label AS "clientLabel",created_at AS "createdAt",last_seen_at AS "lastSeenAt",
           LEAST(idle_expires_at,absolute_expires_at) AS "expiresAt"
           FROM admin_sessions WHERE admin_user_id=$1 AND revoked_at IS NULL
           AND idle_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()
           AND ($3::uuid IS NULL OR id<$3) ORDER BY id DESC LIMIT 26`,
            [account.id, identity.sessionId, 'before' in args ? (args.before ?? null) : null]
          )
        ).rows;
        data = { items: rows.slice(0, 25), nextBefore: rows.length > 25 ? rows[24].id : null };
      }
      await SecurityService.logAuditEventInTransaction(
        client,
        operation === 'recovery'
          ? 'ADMIN_OWN_RECOVERY_READ'
          : operation === 'cancelRecovery'
            ? 'ADMIN_OWN_RECOVERY_CANCELLED'
            : operation === 'sessions'
              ? 'ADMIN_OWN_SESSIONS_READ'
              : operation === 'password'
                ? 'ADMIN_OWN_PASSWORD_CHANGED'
                : operation === 'revokeOthers'
                  ? 'ADMIN_OWN_OTHER_SESSIONS_REVOKED'
                  : 'ADMIN_OWN_SESSION_REVOKED',
        { adminUserId: account.id, ...(target ? { targetSessionId: target } : {}) }
      );
      // Recheck after audit, including failures injected in the same transaction.
      if (changedAt) {
        const valid = (
          await client.query(
            `SELECT a.is_active AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())
           AND a.password_hash=$3 AND a.password_changed_at=$4
           AND s.revoked_at=$4 AND s.idle_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()
           AND $6::timestamptz>clock_timestamp()
           AND NOT EXISTS(SELECT 1 FROM admin_sessions other WHERE other.admin_user_id=a.id AND other.revoked_at IS NULL) AS valid
           FROM admin_sessions s JOIN admin_users a ON a.id=s.admin_user_id
           WHERE s.id=$1 AND s.token_hash=$2 AND a.id=$5`,
            [
              identity.sessionId,
              identity.sessionTokenHash,
              nextHash,
              changedAt,
              account.id,
              session.step_up_expires_at,
            ]
          )
        ).rows[0];
        if (!valid?.valid) return fail(409, 'ACCOUNT_CHANGED');
      } else {
        const after = await lockIdentity(client, identity, write);
        if (
          after.account.password_hash !== account.password_hash ||
          after.session.admin_user_id !== session.admin_user_id
        )
          return fail(409, 'ACCOUNT_CHANGED');
        if (operation === 'recovery' || 'recoveryId' in args) {
          // Refresh projections after audit; confirm exact cancellation without repeating it.
          data = (
            await client.query('SELECT ertad.own_web_recovery($1,$2,$3,$4) result', [
              identity.sessionId,
              identity.sessionTokenHash,
              operation === 'recovery' ? 'read' : 'confirm',
              'recoveryId' in args ? args.recoveryId : null,
            ])
          ).rows[0].result;
        }
        if (
          target &&
          !(
            await client.query(
              'SELECT 1 FROM admin_sessions WHERE id=$1 AND admin_user_id=$2 AND revoked_at IS NOT NULL AND step_up_expires_at IS NULL',
              [target, account.id]
            )
          ).rowCount
        )
          return fail(409, 'SESSION_CHANGED');
        if (
          operation === 'revokeOthers' &&
          (
            await client.query(
              'SELECT 1 FROM admin_sessions WHERE admin_user_id=$1 AND id<>$2 AND revoked_at IS NULL LIMIT 1',
              [account.id, identity.sessionId]
            )
          ).rowCount
        )
          return fail(409, 'SESSION_CHANGED');
      }
      return data;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') return fail(403, 'ACCESS_DENIED');
    if (code === 'P0428') return fail(428, 'STEP_UP_REQUIRED');
    if (code === 'P0409') return fail(409, 'ACCOUNT_CHANGED');
    throw error;
  }
}

function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bytes = randomBytes(8);
    let raw = '';
    for (let j = 0; j < 8; j++) {
      raw += alphabet[bytes[j] % alphabet.length];
    }
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    codes.push(formatted);
    hashes.push(createHash('sha256').update(formatted).digest('hex'));
  }
  return { codes, hashes };
}

function mapPgAccountError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') return fail(403, 'ACCESS_DENIED');
  if (code === 'P0428') return fail(428, 'STEP_UP_REQUIRED');
  if (code === 'P0409' || code === '23505') return fail(409, 'ACCOUNT_CHANGED');
  if (code === 'P0404') return fail(404, 'NOT_FOUND');
  if (['22023', '22P02', '23514'].includes(code ?? '')) return fail(400, 'INVALID_REQUEST');
  throw error;
}

const confirmTotpSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const passkeyLabelSchema = z.object({ label: z.string().trim().min(1).max(80).default('Device Passkey') }).strict();
const passkeyRegisterVerifySchema = z
  .object({
    challengeId: z.string().uuid(),
    label: z.string().trim().min(1).max(80),
    clientDataJSON: z.string().min(16).max(4096),
    attestationObject: z.string().min(32).max(16384),
    transports: z.array(z.string().max(32)).max(8).default([]),
  })
  .strict();
const passkeyRenameSchema = z
  .object({ passkeyId: z.string().uuid(), label: z.string().trim().min(1).max(80) })
  .strict();
const passkeyDeleteSchema = z.object({ passkeyId: z.string().uuid() }).strict();
const notificationsUpdateSchema = z
  .object({
    eventReminders: z.boolean().optional(),
    taskDeadlines: z.boolean().optional(),
    approvalDigests: z.boolean().optional(),
    channelMentions: z.boolean().optional(),
  })
  .strict();

export function createSelfAccountRouter(allowedOrigins: string[] = ['http://localhost:15173', 'http://127.0.0.1:15173']) {
  const router = Router();
  router.use(requireAdmin);
  router.use('/email', createEmailChangeRouter());

  router.get('/totp', async (req, res, next) => {
    try {
      const result = (
        await query('SELECT ertad.own_totp_command($1,$2,$3,$4) AS r', [
          req.adminSession!.sessionId,
          req.adminSession!.sessionTokenHash,
          'status',
          '{}',
        ])
      ).rows[0].r;
      res.set('Cache-Control', 'no-store').json({
        enabled: result.enabled,
        pendingSetup: result.pendingSetup,
        enrolledAt: result.enrolledAt,
        recoveryRemaining: result.recoveryRemaining,
      });
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/totp/setup', requireAdminCsrf, async (req, res, next) => {
    try {
      const secret = generateMfaSecret();
      const encryptedSecret = encryptSensitiveValue(secret);
      const data = await retryDeadlockedTransaction(async (client) => {
        const resRow = (
          await client.query('SELECT ertad.own_totp_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'setup_begin',
            JSON.stringify({ encryptedSecret }),
          ])
        ).rows[0].r;
        await SecurityService.logAuditEventInTransaction(client, 'ADMIN_MFA_SETUP_STARTED', {
          adminUserId: resRow.adminUserId,
        });
        return resRow;
      });
      res.set('Cache-Control', 'no-store').json({
        secret,
        otpauthUri: mfaProvisioningUri(req.adminUser!.email, secret),
        pendingSetup: data.pendingSetup,
      });
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/totp/confirm', requireAdminCsrf, async (req, res, next) => {
    try {
      const parsed = confirmTotpSchema.safeParse(req.body);
      if (!parsed.success) return fail(400, 'INVALID_REQUEST');
      const { codes, hashes } = generateRecoveryCodes();
      const data = await retryDeadlockedTransaction(async (client) => {
        const enc = (
          await client.query('SELECT ertad.read_own_totp_secret($1,$2) AS s', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
          ])
        ).rows[0]?.s;
        if (!enc) return fail(409, 'ACCOUNT_CHANGED');
        const secret = decryptSensitiveValue(enc);
        const counter = matchMfaCounter(secret, parsed.data.code);
        if (counter === null) return fail(400, 'INVALID_TOTP_CODE');
        const resRow = (
          await client.query('SELECT ertad.own_totp_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'setup_confirm',
            JSON.stringify({ counter, recoveryHashes: hashes }),
          ])
        ).rows[0].r;
        await SecurityService.logAuditEventInTransaction(client, 'ADMIN_MFA_ENROLLED', {
          adminUserId: resRow.adminUserId,
        });
        return resRow;
      });
      res.set('Cache-Control', 'no-store').json({
        enabled: true,
        recoveryCodes: codes,
        recoveryRemaining: data.recoveryRemaining,
      });
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/totp/disable', requireAdminCsrf, async (req, res, next) => {
    try {
      const data = await retryDeadlockedTransaction(async (client) => {
        const resRow = (
          await client.query('SELECT ertad.own_totp_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'disable',
            '{}',
          ])
        ).rows[0].r;
        await SecurityService.logAuditEventInTransaction(client, 'ADMIN_MFA_DISABLED', {
          adminUserId: resRow.adminUserId,
        });
        return resRow;
      });
      res.set('Cache-Control', 'no-store').json({ enabled: data.enabled });
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/totp/recovery/regenerate', requireAdminCsrf, async (req, res, next) => {
    try {
      const { codes, hashes } = generateRecoveryCodes();
      const data = await retryDeadlockedTransaction(async (client) => {
        const resRow = (
          await client.query('SELECT ertad.own_totp_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'regenerate_recovery',
            JSON.stringify({ recoveryHashes: hashes }),
          ])
        ).rows[0].r;
        await SecurityService.logAuditEventInTransaction(client, 'ADMIN_MFA_RECOVERY_REGENERATED', {
          adminUserId: resRow.adminUserId,
        });
        return resRow;
      });
      res.set('Cache-Control', 'no-store').json({
        recoveryCodes: codes,
        recoveryRemaining: data.recoveryRemaining,
      });
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/passkeys', async (req, res, next) => {
    try {
      const data = (
        await query('SELECT ertad.own_passkey_command($1,$2,$3,$4) AS r', [
          req.adminSession!.sessionId,
          req.adminSession!.sessionTokenHash,
          'list',
          '{}',
        ])
      ).rows[0].r;
      res.set('Cache-Control', 'no-store').json(data);
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/passkeys/register/options', requireAdminCsrf, async (req, res, next) => {
    try {
      const parsed = passkeyLabelSchema.safeParse(req.body ?? {});
      if (!parsed.success) return fail(400, 'INVALID_REQUEST');
      const challenge = randomBytes(32).toString('base64url');
      const data = (
        await query('SELECT ertad.own_passkey_command($1,$2,$3,$4) AS r', [
          req.adminSession!.sessionId,
          req.adminSession!.sessionTokenHash,
          'challenge_register',
          JSON.stringify({ challenge }),
        ])
      ).rows[0].r;
      const reqOrigin = req.get('origin') || allowedOrigins[0] || 'http://localhost:15173';
      const rpId = rpIdFromOrigin(allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]);
      res.set('Cache-Control', 'no-store').json({
        challengeId: data.challengeId,
        challenge: data.challenge,
        rp: { id: rpId, name: 'ERTAD' },
        user: {
          id: Buffer.from(data.adminUserId).toString('base64url'),
          name: data.email,
          displayName: req.adminUser?.fullName || data.email,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: 120000,
        attestation: 'none',
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
        excludeCredentials: (data.excludeCredentialIds as string[]).map((id) => ({
          type: 'public-key',
          id,
        })),
      });
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/passkeys/register/verify', requireAdminCsrf, async (req, res, next) => {
    try {
      const parsed = passkeyRegisterVerifySchema.safeParse(req.body);
      if (!parsed.success) return fail(400, 'INVALID_REQUEST');
      const reqOrigin = req.get('origin') || allowedOrigins[0] || 'http://localhost:15173';
      const rpId = rpIdFromOrigin(allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0]);

      const out = await retryDeadlockedTransaction(async (client) => {
        const challengeRow = (
          await client.query('SELECT ertad.own_passkey_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'challenge_register_read',
            JSON.stringify({ challengeId: parsed.data.challengeId }),
          ])
        ).rows[0].r;

        const verified = verifyRegistrationAttestation({
          clientDataJSON: parsed.data.clientDataJSON,
          attestationObject: parsed.data.attestationObject,
          expectedChallenge: challengeRow.challenge,
          expectedOrigins: allowedOrigins,
          rpId,
        });
        const reg = (
          await client.query('SELECT ertad.own_passkey_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'register',
            JSON.stringify({
              challengeId: parsed.data.challengeId,
              credentialId: verified.credentialId,
              publicKeySpki: verified.publicKeySpki,
              algorithm: verified.algorithm,
              signCount: verified.signCount,
              label: parsed.data.label,
              transports: parsed.data.transports,
            }),
          ])
        ).rows[0].r;
        await SecurityService.logAuditEventInTransaction(client, 'ADMIN_PASSKEY_REGISTERED', {
          adminUserId: reg.adminUserId,
          passkeyId: reg.id,
        });
        return { id: reg.id, label: reg.label, createdAt: reg.createdAt };
      });
      res.set('Cache-Control', 'no-store').status(201).json(out);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_') || error instanceof Error && ['CHALLENGE_MISMATCH', 'ORIGIN_MISMATCH', 'RP_ID_MISMATCH', 'MISSING_USER_PRESENCE_OR_ATTESTATION', 'TRUNCATED_AUTH_DATA', 'UNSUPPORTED_CREDENTIAL_ALGORITHM', 'UNSUPPORTED_EC2_KEY', 'UNSUPPORTED_RSA_KEY'].includes(error.message)) {
        next(createErrorWithCode(error.message, 'Invalid passkey registration', 400));
        return;
      }
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/passkeys/rename', requireAdminCsrf, async (req, res, next) => {
    try {
      const parsed = passkeyRenameSchema.safeParse(req.body);
      if (!parsed.success) return fail(400, 'INVALID_REQUEST');
      const data = await retryDeadlockedTransaction(async (client) => {
        const resRow = (
          await client.query('SELECT ertad.own_passkey_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'rename',
            JSON.stringify(parsed.data),
          ])
        ).rows[0].r;
        await SecurityService.logAuditEventInTransaction(client, 'ADMIN_PASSKEY_RENAMED', {
          adminUserId: resRow.adminUserId,
          passkeyId: resRow.id,
        });
        return { id: resRow.id, label: resRow.label };
      });
      res.set('Cache-Control', 'no-store').json(data);
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/passkeys/delete', requireAdminCsrf, async (req, res, next) => {
    try {
      const parsed = passkeyDeleteSchema.safeParse(req.body);
      if (!parsed.success) return fail(400, 'INVALID_REQUEST');
      const data = await retryDeadlockedTransaction(async (client) => {
        const resRow = (
          await client.query('SELECT ertad.own_passkey_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'delete',
            JSON.stringify(parsed.data),
          ])
        ).rows[0].r;
        await SecurityService.logAuditEventInTransaction(client, 'ADMIN_PASSKEY_DELETED', {
          adminUserId: resRow.adminUserId,
          passkeyId: resRow.deletedId,
        });
        return { deletedId: resRow.deletedId };
      });
      res.set('Cache-Control', 'no-store').json(data);
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/notifications', async (req, res, next) => {
    try {
      const data = (
        await query('SELECT ertad.own_notifications_command($1,$2,$3,$4) AS r', [
          req.adminSession!.sessionId,
          req.adminSession!.sessionTokenHash,
          'read',
          '{}',
        ])
      ).rows[0].r;
      res.set('Cache-Control', 'no-store').json({
        preferences: data.preferences,
        newlyQueued: data.newlyQueued,
        recentQueued: data.recentQueued,
      });
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/notifications', requireAdminCsrf, async (req, res, next) => {
    try {
      const parsed = notificationsUpdateSchema.safeParse(req.body);
      if (!parsed.success) return fail(400, 'INVALID_REQUEST');
      const data = await retryDeadlockedTransaction(async (client) => {
        const resRow = (
          await client.query('SELECT ertad.own_notifications_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'update',
            JSON.stringify(parsed.data),
          ])
        ).rows[0].r;
        await SecurityService.logAuditEventInTransaction(client, 'ADMIN_NOTIFICATION_PREFS_UPDATED', {
          adminUserId: resRow.adminUserId,
        });
        return resRow;
      });
      res.set('Cache-Control', 'no-store').json({
        preferences: data.preferences,
        newlyQueued: data.newlyQueued,
        recentQueued: data.recentQueued,
      });
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/notifications/sync', requireAdminCsrf, async (req, res, next) => {
    try {
      const data = await retryDeadlockedTransaction(async (client) => {
        const resRow = (
          await client.query('SELECT ertad.own_notifications_command($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'sync_outbox',
            '{}',
          ])
        ).rows[0].r;
        return resRow;
      });
      res.set('Cache-Control', 'no-store').json({
        preferences: data.preferences,
        newlyQueued: data.newlyQueued,
        recentQueued: data.recentQueued,
      });
    } catch (error) {
      try {
        mapPgAccountError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });
  router.get('/recovery', async (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .json(await selfAccountCommand(req.adminSession!, 'recovery', req.query));
    } catch (error) {
      next(error);
    }
  });
  router.get('/sessions', async (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .json(await selfAccountCommand(req.adminSession!, 'sessions', req.query));
    } catch (error) {
      next(error);
    }
  });
  for (const [path, operation] of [
    ['/sessions/revoke', 'revoke'],
    ['/sessions/revoke-others', 'revokeOthers'],
    ['/password', 'password'],
    ['/recovery/cancel', 'cancelRecovery'],
  ] as const)
    router.post(path, requireAdminCsrf, async (req, res, next) => {
      try {
        const result = await selfAccountCommand(req.adminSession!, operation, req.body);
        if (operation === 'password') {
          clearAdminSessionCookie(res);
          res.set('Clear-Site-Data', '"cache"');
        }
        res.set('Cache-Control', 'no-store').json(result);
      } catch (error) {
        next(error);
      }
    });
  return router;
}
