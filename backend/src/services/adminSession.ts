import crypto from 'crypto';
import { Request, Response } from 'express';
import { pool, retryDeadlockedTransaction } from '../db/client';
import type { AdminRole } from '../middleware/auth';
import { encryptSensitiveValue, decryptSensitiveValue } from './secretEncryption';
import { SecurityService } from './security';
import { createErrorWithCode } from '../middleware/errorHandler';

const TOKEN_BYTES = 32;
const SESSION_COOKIE =
  process.env.NODE_ENV === 'production' ? '__Host-ertad_admin_session' : 'ertad_admin_session';

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const IDLE_TIMEOUT_SECONDS = boundedInteger(
  process.env.ADMIN_SESSION_IDLE_SECONDS,
  15 * 60,
  5 * 60,
  60 * 60
);
const ABSOLUTE_TIMEOUT_SECONDS = boundedInteger(
  process.env.ADMIN_SESSION_ABSOLUTE_SECONDS,
  8 * 60 * 60,
  15 * 60,
  24 * 60 * 60
);
const MAX_CONCURRENT_SESSIONS = boundedInteger(process.env.ADMIN_MAX_CONCURRENT_SESSIONS, 3, 1, 10);

export interface AdminSessionIdentity {
  sessionId: string;
  sessionTokenHash: string;
  csrfTokenHash: string;
  id: string;
  email: string;
  role: AdminRole;
  fullName?: string;
  stepUpExpiresAt?: Date;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearAdminSessionCookie(res: Response): void {
  res.append('Set-Cookie', sessionCookie('', 0));
}

export function coarseClientLabel(userAgent: unknown): string {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return 'Web Browser';
  const ua = userAgent.toLowerCase();
  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('firefox/')
      ? 'Firefox'
      : ua.includes('chrome/') || ua.includes('crios/')
        ? 'Chrome'
        : ua.includes('safari/')
          ? 'Safari'
          : 'Browser';
  const os = ua.includes('iphone') || ua.includes('ipad')
    ? 'iOS'
    : ua.includes('android')
      ? 'Android'
      : ua.includes('windows')
        ? 'Windows'
        : ua.includes('mac os') || ua.includes('macintosh')
          ? 'macOS'
          : ua.includes('linux')
            ? 'Linux'
            : 'Desktop';
  return `${browser} / ${os}`;
}

export async function createAdminSession(
  adminUserId: string,
  req: Request,
  res: Response,
  verifiedPasswordHash: string,
  verifiedEmail: string,
  mfaProof?: { encryptedSecret: string; counter: number }
): Promise<string> {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const tokenHash = sha256(sessionToken);
  const csrfTokenHash = sha256(csrfToken);
  const clientLabel = coarseClientLabel(
    typeof req?.get === 'function' ? req.get('user-agent') : req?.headers?.['user-agent']
  );
  let absoluteSeconds = ABSOLUTE_TIMEOUT_SECONDS;
  await retryDeadlockedTransaction(async (client) => {
    const activeUser = await client.query(
      `SELECT id FROM admin_users WHERE id = $1 AND password_hash=$2 AND is_active = true
       AND (locked_until IS NULL OR locked_until <= clock_timestamp())
       AND ($3::text IS NULL OR (mfa_enabled AND mfa_secret_encrypted=$3 AND mfa_last_counter=$4)) AND email=$5
       AND NOT ertad.web_account_held(id) FOR UPDATE`,
      [adminUserId, verifiedPasswordHash, mfaProof?.encryptedSecret ?? null, mfaProof?.counter ?? null,verifiedEmail]
    );
    if (!activeUser.rows[0]) throw createErrorWithCode('CREDENTIAL_CHANGED','Sign in again',401);
    const policy = (await client.query('SELECT ertad.current_session_policy() AS policy')).rows[0]
      .policy;
    absoluteSeconds = policy?.absoluteSeconds ?? ABSOLUTE_TIMEOUT_SECONDS;
    const idleSeconds = Math.min(policy?.idleSeconds ?? IDLE_TIMEOUT_SECONDS, absoluteSeconds);
    await client.query(
      `DELETE FROM admin_sessions
        WHERE admin_user_id = $1
          AND (absolute_expires_at <= NOW() OR revoked_at < NOW() - INTERVAL '30 days')`,
      [adminUserId]
    );

    await client.query(
      `INSERT INTO admin_sessions
         (admin_user_id, token_hash, csrf_token_hash, idle_expires_at,
          absolute_expires_at, csrf_token_encrypted, policy_idle_seconds, policy_version, client_label)
       VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'),
               NOW() + ($5 * INTERVAL '1 second'), $6, $4, $7, $8)`,
      [
        adminUserId,
        tokenHash,
        csrfTokenHash,
        idleSeconds,
        absoluteSeconds,
        encryptSensitiveValue(csrfToken),
        policy?.version ?? null,
        clientLabel,
      ]
    );

    await client.query(
      `UPDATE admin_sessions
          SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE id IN (
          SELECT id
            FROM admin_sessions
           WHERE admin_user_id = $1 AND revoked_at IS NULL AND idle_expires_at > NOW() AND absolute_expires_at > NOW()
           ORDER BY created_at DESC
          OFFSET $2
        )`,
      [adminUserId, policy?.maxSessions ?? MAX_CONCURRENT_SESSIONS]
    );
    await SecurityService.logAuditEventInTransaction(client, 'ADMIN_LOGIN_SUCCEEDED', {
      adminUserId,
    });
    const stillValid = await client.query(
      `SELECT 1 FROM admin_users a JOIN admin_sessions s ON s.admin_user_id=a.id
       WHERE a.id=$1 AND a.password_hash=$2 AND a.is_active
       AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())
       AND ($4::text IS NULL OR (a.mfa_enabled AND a.mfa_secret_encrypted=$4 AND a.mfa_last_counter=$5))
       AND a.email=$6
       AND NOT ertad.web_account_held(a.id)
       AND s.token_hash=$3 AND s.revoked_at IS NULL
       AND s.idle_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()`,
      [adminUserId,verifiedPasswordHash,tokenHash,mfaProof?.encryptedSecret ?? null,mfaProof?.counter ?? null,verifiedEmail]
    );
    if (!stillValid.rowCount) throw createErrorWithCode('CREDENTIAL_CHANGED','Sign in again',401);
  });

  res.append('Set-Cookie', sessionCookie(sessionToken, absoluteSeconds));
  return csrfToken;
}

/** Issues a bearer-authenticated mobile session reusing strict session policy & concurrency rules. */
export async function createMobileBearerSession(
  adminUserId: string,
  verifiedPasswordHash: string,
  verifiedEmail: string,
  clientLabel = 'ERTAD Mobile'
): Promise<{ sessionToken: string; csrfToken: string }> {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const tokenHash = sha256(sessionToken);
  const csrfTokenHash = sha256(csrfToken);
  await retryDeadlockedTransaction(async (client) => {
    const activeUser = await client.query(
      `SELECT id FROM admin_users WHERE id = $1 AND password_hash=$2 AND is_active = true
       AND (locked_until IS NULL OR locked_until <= clock_timestamp())
       AND email=$3 AND NOT ertad.web_account_held(id) FOR UPDATE`,
      [adminUserId, verifiedPasswordHash, verifiedEmail]
    );
    if (!activeUser.rows[0]) throw createErrorWithCode('CREDENTIAL_CHANGED', 'Sign in again', 401);
    const policy = (await client.query('SELECT ertad.current_session_policy() AS policy')).rows[0]
      .policy;
    const absoluteSeconds = policy?.absoluteSeconds ?? ABSOLUTE_TIMEOUT_SECONDS;
    const idleSeconds = Math.min(policy?.idleSeconds ?? IDLE_TIMEOUT_SECONDS, absoluteSeconds);
    await client.query(
      `DELETE FROM admin_sessions
        WHERE admin_user_id = $1
          AND (absolute_expires_at <= NOW() OR revoked_at < NOW() - INTERVAL '30 days')`,
      [adminUserId]
    );
    await client.query(
      `INSERT INTO admin_sessions
         (admin_user_id, token_hash, csrf_token_hash, idle_expires_at,
          absolute_expires_at, csrf_token_encrypted, policy_idle_seconds, policy_version, client_label)
       VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'),
               NOW() + ($5 * INTERVAL '1 second'), $6, $4, $7, $8)`,
      [
        adminUserId,
        tokenHash,
        csrfTokenHash,
        idleSeconds,
        absoluteSeconds,
        encryptSensitiveValue(csrfToken),
        policy?.version ?? null,
        clientLabel.slice(0, 64),
      ]
    );
    await client.query(
      `UPDATE admin_sessions
          SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE id IN (
          SELECT id
            FROM admin_sessions
           WHERE admin_user_id = $1 AND revoked_at IS NULL AND idle_expires_at > NOW() AND absolute_expires_at > NOW()
           ORDER BY created_at DESC
          OFFSET $2
        )`,
      [adminUserId, policy?.maxSessions ?? MAX_CONCURRENT_SESSIONS]
    );
    await SecurityService.logAuditEventInTransaction(client, 'MOBILE_SESSION_ISSUED', {
      adminUserId,
    });
  });
  return { sessionToken, csrfToken };
}

/** Authenticates an opaque bearer token for mobile API routes, excluding platform operators. */
export async function authenticateMobileBearerSession(
  rawToken: string | undefined
): Promise<(AdminSessionIdentity & { memberUserId: string }) | null> {
  if (!rawToken || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
  const tokenHash = sha256(rawToken);
  const result = await pool.query(
    `UPDATE admin_sessions AS s
        SET last_seen_at = NOW(),
            idle_expires_at = LEAST(
              s.absolute_expires_at,
              NOW() + (COALESCE(s.policy_idle_seconds, $2) * INTERVAL '1 second')
            )
       FROM admin_users AS u
       JOIN member_users AS mu ON mu.web_account_id = u.id
      WHERE s.token_hash = $1
        AND s.admin_user_id = u.id
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > NOW()
        AND s.absolute_expires_at > NOW()
        AND u.is_active = true
        AND mu.status = 'active'
        AND NOT ertad.web_account_held(u.id)
        AND NOT ertad.is_platform_account(u.id)
        AND (u.locked_until IS NULL OR u.locked_until <= NOW())
      RETURNING s.id AS session_id, s.token_hash, s.csrf_token_hash, s.step_up_expires_at,
                u.id, u.email, u.role, u.full_name, mu.id AS member_user_id`,
    [tokenHash, IDLE_TIMEOUT_SECONDS]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    sessionTokenHash: row.token_hash,
    csrfTokenHash: row.csrf_token_hash,
    id: row.id,
    email: row.email,
    role: row.role,
    fullName: row.full_name || undefined,
    stepUpExpiresAt: row.step_up_expires_at || undefined,
    memberUserId: row.member_user_id,
  };
}

export async function authenticateAdminSession(req: Request): Promise<AdminSessionIdentity | null> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;

  const tokenHash = sha256(token);
  const result = await pool.query(
    `UPDATE admin_sessions AS s
        SET last_seen_at = NOW(),
            idle_expires_at = LEAST(
              s.absolute_expires_at,
              NOW() + (COALESCE(s.policy_idle_seconds, $2) * INTERVAL '1 second')
            )
       FROM admin_users AS u
      WHERE s.token_hash = $1
        AND s.admin_user_id = u.id
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > NOW()
        AND s.absolute_expires_at > NOW()
        AND u.is_active = true
        AND NOT ertad.web_account_held(u.id)
        AND (u.locked_until IS NULL OR u.locked_until <= NOW())
      RETURNING s.id AS session_id, s.token_hash, s.csrf_token_hash, s.step_up_expires_at,
                u.id, u.email, u.role, u.full_name`,
    [tokenHash, IDLE_TIMEOUT_SECONDS]
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    sessionTokenHash: row.token_hash,
    csrfTokenHash: row.csrf_token_hash,
    id: row.id,
    email: row.email,
    role: row.role,
    fullName: row.full_name || undefined,
    stepUpExpiresAt: row.step_up_expires_at || undefined,
  };
}

export function verifyAdminCsrf(identity: AdminSessionIdentity, suppliedToken: unknown): boolean {
  if (typeof suppliedToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(suppliedToken)) {
    return false;
  }
  const actual = Buffer.from(sha256(suppliedToken), 'hex');
  const expected = Buffer.from(identity.csrfTokenHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function rotateAdminCsrf(sessionId: string): Promise<string> {
  const csrfToken = randomToken();
  await pool.query(
    `UPDATE admin_sessions
        SET csrf_token_hash = $2, csrf_token_encrypted = $3
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, sha256(csrfToken), encryptSensitiveValue(csrfToken)]
  );
  return csrfToken;
}

// /me is read-only: concurrent tabs or StrictMode checks must not invalidate each other's CSRF proof.
export async function readAdminCsrf(sessionId: string): Promise<string> {
  const result = await pool.query(
    'SELECT csrf_token_encrypted FROM admin_sessions WHERE id = $1 AND revoked_at IS NULL',
    [sessionId]
  );
  if (!result.rows[0]) throw new Error('Session is unavailable');
  return decryptSensitiveValue(result.rows[0].csrf_token_encrypted);
}

export async function revokeAdminSession(sessionId: string): Promise<void> {
  await pool.query(
    'UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1',
    [sessionId]
  );
}

export async function revokeAllAdminSessions(adminUserId: string): Promise<void> {
  await pool.query(
    'UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE admin_user_id = $1 AND revoked_at IS NULL',
    [adminUserId]
  );
}

export const adminSessionPolicy = {
  cookieName: SESSION_COOKIE,
  idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  absoluteTimeoutSeconds: ABSOLUTE_TIMEOUT_SECONDS,
  maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
};
