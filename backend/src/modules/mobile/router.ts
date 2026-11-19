import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { pool, retryDeadlockedTransaction } from '../../db/client';
import { createError, createErrorWithCode } from '../../middleware/errorHandler';
import {
  authenticateMobileBearerSession,
  createMobileBearerSession,
  revokeAdminSession,
  verifyAdminCsrf,
} from '../../services/adminSession';
import { SecurityService } from '../../services/security';
import { createChannelRouter } from '../communication/channels';
import { createInboxRouter } from '../communication/inbox';
import { createRealtimeRouter } from '../communication/realtime';
import { createDecisionRouter } from '../decisions/polls';
import { createCollectiveRouter } from '../governance/collective';
import { createReviewRouter, ReviewError } from '../governance/reviews';
import { createWorkspaceRouter } from '../governance/workspace';
import { createInvitationsRouter } from '../identity/invitations';
import { createSelfAccountRouter } from '../identity/selfAccount';
import { createMemberDirectoryRouter } from '../organization/members';
import { createUnitRouter } from '../organization/units';
import { createEvidenceRouter } from '../work/evidence';
import { createMaterialFilesRouter } from '../work/materialFiles';
import { createWorkRouter } from '../work/tasks';
import { createMobileM4Router } from './m4Auth';

export const mobileDevFile = fileURLToPath(
  new URL('../../../../.local/mobile-dev-access.json', import.meta.url)
);

export const mobileDevSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.string().uuid(),
    personas: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            memberId: z.string().uuid(),
            unitId: z.string().uuid(),
            unitName: z.string().min(1).max(120),
            email: z.string().email().endsWith('@mobile.ertad.local'),
            password: z.string().min(24).max(128),
            label: z.string().min(1).max(120),
            roleKind: z.enum(['member', 'group_manager']),
          })
          .strict()
      )
      .min(1)
      .max(10),
  })
  .strict();

export type MobileDevAccess = z.infer<typeof mobileDevSchema>;

const uuid = z.string().uuid();
const privacyQuerySchema = z.object({ organizationId: uuid }).strict();
const privacyUpdateSchema = z
  .object({
    organizationId: uuid,
    disclosureMode: z.enum(['private_hidden', 'bucketed_k10', 'shared_context_opt_in']),
    displayName: z.string().trim().max(120).optional(),
  })
  .strict();

function defaultDevReader(): MobileDevAccess | null {
  try {
    return mobileDevSchema.parse(JSON.parse(readFileSync(mobileDevFile, 'utf8')));
  } catch {
    return null;
  }
}

function isLoopbackHostOrPeer(req: Request): boolean {
  const peer = req.socket.remoteAddress ?? '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
}

/** Authenticates Bearer mobile session and translates validated mobile CSRF for domain routers. */
function requireMobileBearer(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(createError('Authentication required', 401));
    return;
  }
  const rawToken = header.slice(7).trim();
  authenticateMobileBearerSession(rawToken)
    .then((identity) => {
      if (!identity) {
        next(createError('Invalid or expired session', 401));
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
        const mobileCsrf = req.headers['x-mobile-csrf'];
        if (!verifyAdminCsrf(identity, mobileCsrf)) {
          next(createError('Invalid or missing mobile CSRF token', 403));
          return;
        }
        // Bridge verified CSRF proof for downstream shared domain sub-routers cleanly.
        req.headers['x-admin-csrf'] = String(mobileCsrf);
      }
      req.adminSession = identity;
      req.adminUser = {
        id: identity.id,
        email: identity.email,
        role: identity.role,
        fullName: identity.fullName,
      };
      next();
    })
    .catch(next);
}

export function createLocalMobileRouter(
  origin: string,
  devReader: () => MobileDevAccess | null = defaultDevReader
): Router {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    throw new Error('Local mobile dev bridge is restricted to development/test environments');
  }

  const router = Router();
  const devEnabled = process.env.ERTAD_LOCAL_ADMIN === 'true';

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Scoped development persona switcher (strictly excludes council/regional/platform accounts).
  router.get('/dev/personas', (req, res) => {
    if (!devEnabled || !isLoopbackHostOrPeer(req)) {
      res.status(404).json({ error: { code: 'NOT_FOUND' } });
      return;
    }
    const fixture = devReader();
    if (!fixture) {
      res.json({ enabled: false, personas: [] });
      return;
    }
    res.json({
      enabled: true,
      organizationId: fixture.organizationId,
      personas: fixture.personas.map(({ id, memberId, unitId, unitName, label, roleKind }) => ({
        id,
        memberId,
        unitId,
        unitName,
        label,
        roleKind,
      })),
    });
  });

  router.post('/dev/login', async (req, res, next) => {
    try {
      if (!devEnabled || !isLoopbackHostOrPeer(req)) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } });
        return;
      }
      const parsed = z.object({ personaId: uuid }).strict().safeParse(req.body);
      if (!parsed.success) throw createError('Invalid request', 400);
      const fixture = devReader();
      const persona = fixture?.personas.find((p) => p.id === parsed.data.personaId);
      if (!fixture || !persona) throw createErrorWithCode('PERSONA_UNAVAILABLE', 'Access denied', 403);

      const userRow = (
        await pool.query(
          `SELECT a.id, a.email, a.password_hash, a.is_active, a.locked_until, mu.id AS member_id
             FROM admin_users a
             JOIN member_users mu ON mu.web_account_id = a.id
            WHERE a.id = $1
              AND a.email = $2
              AND mu.id = $3
              AND a.is_active = true
              AND mu.status = 'active'
              AND NOT ertad.web_account_held(a.id)
              AND NOT ertad.is_platform_account(a.id)
              AND EXISTS (
                SELECT 1 FROM memberships m
                JOIN organizations o ON o.id = m.organization_id
                WHERE m.user_id = mu.id
                  AND m.organization_id = $4
                  AND m.unit_id = $5
                  AND o.status = 'active'
                  AND m.status = 'active'
                  AND m.valid_from <= NOW()
                  AND (m.valid_until IS NULL OR m.valid_until > NOW())
              )`,
          [persona.id, persona.email, persona.memberId, fixture.organizationId, persona.unitId]
        )
      ).rows[0];

      if (!userRow || (userRow.locked_until && new Date(userRow.locked_until).getTime() > Date.now())) {
        throw createErrorWithCode('PERSONA_UNAVAILABLE', 'Access denied', 403);
      }

      const ok = await bcrypt.compare(persona.password, userRow.password_hash);
      if (!ok) throw createError('Invalid credentials', 401);

      const issued = await createMobileBearerSession(
        userRow.id,
        userRow.password_hash,
        userRow.email,
        'ERTAD Mobile Dev'
      );

      res.json({
        sessionToken: issued.sessionToken,
        csrfToken: issued.csrfToken,
        persona: {
          id: persona.id,
          memberId: persona.memberId,
          organizationId: fixture.organizationId,
          unitId: persona.unitId,
          unitName: persona.unitName,
          label: persona.label,
          roleKind: persona.roleKind,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // Protected member/group-manager mobile API surface
  router.use(requireMobileBearer);

  router.post('/dev/logout', async (req, res, next) => {
    try {
      await revokeAdminSession(req.adminSession!.sessionId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // Development-only step-up confirmation for testing 428 -> action flows without faking production auth.
  router.post('/dev/step-up', async (req, res, next) => {
    try {
      if (!devEnabled || !isLoopbackHostOrPeer(req)) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } });
        return;
      }
      const fixture = devReader();
      const persona = fixture?.personas.find((p) => p.id === req.adminUser?.id);
      if (!persona) throw createError('Forbidden', 403);
      await pool.query(
        "UPDATE admin_sessions SET step_up_expires_at = clock_timestamp() + interval '5 minutes' WHERE id = $1 AND revoked_at IS NULL",
        [req.adminSession!.sessionId]
      );
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // Member privacy disclosure & opt-in label management (migration 0070)
  router.get('/privacy', async (req, res, next) => {
    try {
      const parsed = privacyQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
      const data = await retryDeadlockedTransaction(async (client) => {
        const resRow = (
          await client.query('SELECT ertad.member_privacy_command($1,$2,$3,$4,$5) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'get',
            parsed.data.organizationId,
            '{}',
          ])
        ).rows[0].r;
        return resRow.data;
      });
      res.json(data);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '42501') return next(new ReviewError(403, 'ACCESS_DENIED'));
      next(error);
    }
  });

  router.post('/privacy/update', async (req, res, next) => {
    try {
      const parsed = privacyUpdateSchema.safeParse(req.body);
      if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
      const data = await retryDeadlockedTransaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        const first = (
          await client.query('SELECT ertad.member_privacy_command($1,$2,$3,$4,$5) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'set',
            parsed.data.organizationId,
            JSON.stringify({
              disclosureMode: parsed.data.disclosureMode,
              ...(parsed.data.displayName !== undefined
                ? { displayName: parsed.data.displayName }
                : {}),
            }),
          ])
        ).rows[0].r;
        await SecurityService.logAuditEventInTransaction(
          client,
          'MEMBER_PRIVACY_UPDATED',
          first.audit
        );
        return (
          await client.query('SELECT ertad.member_privacy_command($1,$2,$3,$4,$5) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            'get',
            parsed.data.organizationId,
            '{}',
          ])
        ).rows[0].r.data;
      });
      res.json(data);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '42501') return next(new ReviewError(403, 'ACCESS_DENIED'));
      if (['22023', '22P02', '23514'].includes(code ?? '')) {
        return next(new ReviewError(400, 'INVALID_REQUEST'));
      }
      next(error);
    }
  });

  // Reuse existing scoped ERTAD SQL-enforced domain sub-routers (never platform console)
  router.use('/workspace', createWorkspaceRouter());
  router.use('/decisions', createDecisionRouter());
  router.use('/work', createWorkRouter());
  router.use('/work-evidence', createEvidenceRouter());
  router.use('/work-material-files', createMaterialFilesRouter());
  router.use('/collective', createCollectiveRouter());
  router.use('/channels', createChannelRouter());
  router.use('/inbox', createInboxRouter());
  router.use('/invitations', createInvitationsRouter());
  router.use('/reviews', createReviewRouter());
  router.use('/units', createUnitRouter());
  router.use('/members', createMemberDirectoryRouter());
  router.use('/account', createSelfAccountRouter([origin]));
  router.use('/stream', createRealtimeRouter());
  router.use('/m4', createMobileM4Router());

  return router;
}

