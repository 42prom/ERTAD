import { Router, Request, Response, NextFunction } from 'express';
import { requireCredential } from '../middleware/auth';
import { pool } from '../db/client';
import { createError } from '../middleware/errorHandler';

const router = Router();

/**
 * GET /api/v1/activity/me
 * Get user's activity history (participations)
 *
 * Privacy: Returns ONLY participation status.
 * Does NOT reveal vote choice/option_id.
 */
router.get(
  '/me',
  requireCredential,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.credential) {
        throw createError('Credential missing', 401);
      }

      const userId = req.credential.sub;
      const result = await pool.query(
        `SELECT
            pp.poll_id,
            pp.participated_at as voted_at,
            p.title,
            p.type,
            p.end_at,
            p.status
         FROM poll_participants pp
         JOIN polls p ON pp.poll_id = p.id
         WHERE pp.user_id = $1
         ORDER BY pp.participated_at DESC`,
        [userId]
      );

      // Map to ActivityItem shape expected by mobile
      const activities = result.rows.map(row => ({
        pollId: row.poll_id,
        title: row.title,
        type: row.type,
        votedAt: row.voted_at,
        endsAt: row.end_at,
        status: row.status,
      }));

      res.json({ activities });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
