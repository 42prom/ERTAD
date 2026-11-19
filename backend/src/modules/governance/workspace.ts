import { Router } from 'express';
import { retryDeadlockedTransaction } from '../../db/client';
import { requireAdmin } from '../../middleware/auth';
import { SecurityService } from '../../services/security';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from './reviews';

export async function workspaceBootstrap(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>
) {
  try {
    return await retryDeadlockedTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const first = (
        await client.query('SELECT ertad.workspace_bootstrap($1, $2) AS result', [
          session.sessionId,
          session.sessionTokenHash,
        ])
      ).rows[0].result;
      await SecurityService.logAuditEventInTransaction(client, 'WORKSPACE_BOOTSTRAP', first.audit);
      // Re-evaluate live session, platform grant, and unit scope after audit persistence.
      return (
        await client.query('SELECT ertad.workspace_bootstrap($1, $2) AS result', [
          session.sessionId,
          session.sessionTokenHash,
        ])
      ).rows[0].result.data;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    if (['22023', '22P02', '23514'].includes(code ?? '')) {
      throw new ReviewError(400, 'INVALID_REQUEST');
    }
    throw error;
  }
}

export function createWorkspaceRouter(): Router {
  const router = Router();
  router.use(requireAdmin);
  router.get('/bootstrap', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(await workspaceBootstrap(req.adminSession!));
    } catch (error) {
      next(error);
    }
  });
  return router;
}

