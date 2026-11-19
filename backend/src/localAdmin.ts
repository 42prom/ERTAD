import { Router } from 'express';
import { createAdminAuthRouter } from './routes/admin/auth';
import { requireAdmin } from './middleware/auth';
import { createReviewRouter } from './modules/governance/reviews';
import { createLocalDemoRouter } from './localDemo';
import { createUnitRouter } from './modules/organization/units';
import { createMemberDirectoryRouter } from './modules/organization/members';
import { createPlatformRouter } from './modules/security/platform';
import { createDecisionRouter } from './modules/decisions/polls';
import { createWorkRouter } from './modules/work/tasks';
import { createEvidenceRouter } from './modules/work/evidence';
import { createMaterialFilesRouter } from './modules/work/materialFiles';
import { createCollectiveRouter } from './modules/governance/collective';
import { createInboxRouter } from './modules/communication/inbox';
import { createChannelRouter } from './modules/communication/channels';
import { createWorkspaceRouter } from './modules/governance/workspace';
import { createRealtimeRouter } from './modules/communication/realtime';
import { createInvitationsRouter } from './modules/identity/invitations';
import { createRecoveryRouter } from './modules/identity/recovery';

export function createLocalAdminRouter(
  origin: string,
  demoReader?: () => unknown,
  platformDemoReader?: () => unknown
) {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    throw new Error('Local administrator access is unavailable outside development/tests');
  }
  const router = Router();
  const origins = new Set([origin]);
  const loopback = new URL(origin);
  if (loopback.hostname === 'localhost' || loopback.hostname === '127.0.0.1') {
    loopback.hostname = loopback.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    origins.add(loopback.origin);
  }
  if (process.env.ERTAD_TUNNEL === 'true' && process.env.ERTAD_TUNNEL_ORIGIN) {
    origins.add(process.env.ERTAD_TUNNEL_ORIGIN);
  }
  router.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origins.has(req.get('origin') ?? '')) {
      res
        .status(403)
        .json({ error: { code: 'ORIGIN_REJECTED', message: 'Request origin is not allowed' } });
      return;
    }
    next();
  });
  // Local development still verifies the password, session, Origin and CSRF.
  // Production startup is blocked; mandatory MFA for all web users is a release gate.
  const auth = createAdminAuthRouter({ requireMfa: false, allowedOrigins: [...origins] });
  router.use('/demo', createLocalDemoRouter(origin, auth, demoReader, platformDemoReader));
  router.use('/auth', auth);
  router.use('/invitations', createInvitationsRouter());
  router.use('/recovery', createRecoveryRouter());
  router.use('/platform', createPlatformRouter());
  router.use('/reviews', createReviewRouter());
  router.use('/units', createUnitRouter());
  router.use('/members', createMemberDirectoryRouter());
  router.use('/decisions', createDecisionRouter());
  router.use('/work', createWorkRouter());
  router.use('/work-evidence', createEvidenceRouter());
  router.use('/work-material-files', createMaterialFilesRouter());
  router.use('/collective', createCollectiveRouter());
  router.use('/inbox', createInboxRouter());
  router.use('/channels', createChannelRouter());
  router.use('/workspace', createWorkspaceRouter());
  router.use('/stream', createRealtimeRouter(origins));
  // Authenticating the local browser does not activate legacy role-based product operations.
  router.use(requireAdmin, (_req, res) =>
    res.status(403).json({
      error: { code: 'FEATURE_NOT_ENABLED', message: 'ეს ფუნქცია ERTAD-ში ჯერ არ არის ჩართული.' },
    })
  );
  return router;
}
