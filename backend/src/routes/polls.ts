import { Router, Request, Response, NextFunction } from 'express';
import { requireCredential } from '../middleware/auth';
import { getEligiblePolls, getPollById } from '../services/polls';
import { createError } from '../middleware/errorHandler';

const router = Router();

/**
 * GET /api/v1/polls
 * List eligible polls for authenticated user
 */
router.get(
  '/',
  requireCredential,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.credential) {
        throw createError('Credential missing', 401);
      }

      const polls = await getEligiblePolls(req.credential.data, req.credential.sub);
      res.json({ polls });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/polls/:id
 * Get detailed poll information
 */
router.get(
  '/:id',
  requireCredential,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pollData = await getPollById(String(req.params.id));
      if (!pollData) {
        throw createError('Poll not found', 404);
      }

      // Check if user is eligible (demo simple: if it exists, they can view it)
      // For Activity history, they already voted, so they definitely can view it.
      res.json(pollData);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
