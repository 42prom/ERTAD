import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from './middleware/auth';
import { createError } from './middleware/errorHandler';
import { query } from './db/client';
import { reviewCommand } from './modules/governance/reviews';

export const demoFile = fileURLToPath(
  new URL('../../.local/web-demo-access.json', import.meta.url)
);
export const demoSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.string().uuid(),
    accounts: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            memberId: z.string().uuid(),
            unitId: z.string().uuid(),
            email: z.string().email().endsWith('@demo.ertad.local'),
            password: z.string().min(24).max(128),
            label: z.string().min(1).max(120),
            region: z.string().min(1).max(120),
          })
          .strict()
      )
      .length(6),
  })
  .strict();
export type DemoAccess = z.infer<typeof demoSchema>;

const platformDemoFile = fileURLToPath(
  new URL('../../.local/platform-access.json', import.meta.url)
);
const platformReviewerDemoFile = fileURLToPath(
  new URL('../../.local/platform-reviewer-access.json', import.meta.url)
);
const platformDemoSchema = z
  .object({
    id: z.string().uuid(),
    email: z.enum(['platform@ertad.local', 'platform-reviewer@ertad.local']),
    password: z.string().min(24).max(128),
    validUntil: z.string().datetime(),
  })
  .strict();
// Isolated tests must explicitly supply their synthetic technical fixture.
function readPlatformDemo(): unknown {
  if (process.env.NODE_ENV !== 'development') return null;
  try {
    return JSON.parse(readFileSync(platformDemoFile, 'utf8'));
  } catch {
    return null;
  }
}
function readPlatformReviewerDemo(): unknown {
  if (process.env.NODE_ENV !== 'development') return null;
  try {
    return JSON.parse(readFileSync(platformReviewerDemoFile, 'utf8'));
  } catch {
    return null;
  }
}

export function createLocalDemoRouter(
  origin: string,
  auth: Router,
  read = () => JSON.parse(readFileSync(demoFile, 'utf8')),
  platformReader: () => unknown = readPlatformDemo
) {
  const router = Router();
  const enabled = process.env.ERTAD_WEB_DEMO === 'true';
  if (enabled && !['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    throw new Error('Demo requires development/test mode');
  const allowed = new Set([origin]);
  const alternate = new URL(origin);
  if (['localhost', '127.0.0.1'].includes(alternate.hostname)) {
    alternate.hostname = alternate.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    allowed.add(alternate.origin);
  } else if (enabled) throw new Error('Demo requires a loopback origin');
  if (process.env.ERTAD_TUNNEL === 'true' && process.env.ERTAD_TUNNEL_ORIGIN) {
    allowed.add(process.env.ERTAD_TUNNEL_ORIGIN);
  }
  // An explicit local-only fixture login, never a production identity shortcut.
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) {
      if (req.method === 'GET' && req.path === '/accounts') {
        res.json({ enabled: false, accounts: [] });
        return;
      }
      res.sendStatus(404);
      return;
    }
    const peer = req.socket.remoteAddress;
    const isTunnel =
      process.env.ERTAD_TUNNEL === 'true' && req.hostname === process.env.ERTAD_TUNNEL_HOST;
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') ||
      (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname) && !isTunnel) ||
      req.get('sec-fetch-site') === 'cross-site' ||
      (req.get('origin') && !allowed.has(req.get('origin')!)) ||
      (req.method !== 'GET' && !allowed.has(req.get('origin') ?? ''))
    ) {
      res.sendStatus(403);
      return;
    }
    next();
  });
  const load = () => {
    const fixture = demoSchema.parse(read());
    if (
      new Set(fixture.accounts.map((a) => a.id)).size !== 6 ||
      new Set(fixture.accounts.map((a) => a.email)).size !== 6
    )
      throw new Error('Invalid demo account set');
    return fixture;
  };
  const loadPlatformAccounts = () => {
    const list: z.infer<typeof platformDemoSchema>[] = [];
    for (const raw of [platformReader(), platformReader === readPlatformDemo ? readPlatformReviewerDemo() : null]) {
      if (!raw) continue;
      try {
        const parsed = platformDemoSchema.safeParse(raw);
        if (parsed.success && !list.some((x) => x.id === parsed.data.id)) {
          list.push(parsed.data);
        }
      } catch {
        // Ignore malformed optional technical fixture
      }
    }
    return list;
  };
  router.get('/accounts', (_req, res, next) => {
    try {
      const accounts: {
        id: string;
        email: string;
        label: string;
        region: string;
        kind?: 'technical';
      }[] = load().accounts.map(({ id, email, label, region }) => ({ id, email, label, region }));
      for (const technical of loadPlatformAccounts()) {
        if (!accounts.some((a) => a.id === technical.id)) {
          accounts.push({
            id: technical.id,
            email: technical.email,
            label:
              technical.email === 'platform-reviewer@ertad.local'
                ? 'ტექნიკური მიმომხილველი'
                : 'ტექნიკური ადმინისტრატორი',
            region: 'სისტემა',
            kind: 'technical',
          });
        }
      }
      res.json({ enabled: true, accounts });
    } catch (error) {
      next(error);
    }
  });
  const delegate =
    (operation: 'login' | 'step-up') =>
    async (req: Parameters<Router>[0], res: Parameters<Router>[1], next: Parameters<Router>[2]) => {
      try {
        const fixture = load();
        const id =
          operation === 'login'
            ? z.object({ accountId: z.string().uuid() }).strict().parse(req.body).accountId
            : req.adminUser?.id;
        const account = fixture.accounts.find((a) => a.id === id);
        if (!account) {
          const technical =
            operation === 'login'
              ? loadPlatformAccounts().find((t) => t.id === id) ?? null
              : null;
          if (!technical) throw createError('Demo account unavailable', 403);
          const match = await query(
            `SELECT a.id FROM admin_users a WHERE a.id=$1 AND a.email=$2 AND a.is_active
          AND NOT EXISTS(SELECT 1 FROM member_users m WHERE m.web_account_id=a.id)`,
            [technical.id, technical.email]
          );
          if (!match.rows.length) throw createError('Demo account unavailable', 403);
          // Password/session checks are unchanged. Login never creates, renews or revives technical grants.
          // Technical step-up continues to require the operator's password through /auth/step-up.
          req.body = { email: technical.email, password: technical.password };
          req.url = '/login';
          auth(req, res, next);
          return;
        }
        const match = await query(
          `SELECT a.id FROM admin_users a JOIN member_users u ON u.web_account_id=a.id
        WHERE a.id=$1 AND a.email=$2 AND u.id=$3 AND u.status='active' AND EXISTS
        (SELECT 1 FROM memberships m JOIN organizations o ON o.id=m.organization_id
        WHERE m.user_id=u.id AND m.organization_id=$4 AND o.status='active' AND m.status='active'
        AND m.valid_from<=now() AND (m.valid_until IS NULL OR m.valid_until>now()))`,
          [account.id, account.email, account.memberId, fixture.organizationId]
        );
        if (!match.rows.length) throw createError('Demo account unavailable', 403);
        // Reuse password verification, account lockout, session issuance, CSRF and strict audit.
        req.body = { email: account.email, password: account.password };
        req.url = `/${operation}`;
        auth(req, res, next);
      } catch (error) {
        next(error instanceof z.ZodError ? createError('Invalid request', 400) : error);
      }
    };
  router.post('/login', delegate('login'));
  router.post('/step-up', requireAdmin, delegate('step-up'));
  router.get('/scenario', requireAdmin, async (req, res, next) => {
    try {
      const fixture = load();
      if (!fixture.accounts.some((a) => a.id === req.adminUser?.id))
        throw createError('Demo account unavailable', 403);
      const contexts = await reviewCommand(req.adminSession!, 'contexts', {});
      const context = contexts.find((c: { id: string }) => c.id === fixture.organizationId);
      const units = new Set<string>(
        (context?.positions ?? []).map((p: { unitId: string }) => p.unitId)
      );
      res.json({
        accounts: fixture.accounts
          .filter((a) => units.has(a.unitId))
          .map(({ id, memberId, label, region }) => ({ id, memberId, label, region })),
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
