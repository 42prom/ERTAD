import { Router, Request, Response, NextFunction } from 'express';
import NonceService from '../services/nonce';
import { ChallengeResponse } from '../types/credentials';
import { createError } from '../middleware/errorHandler';

const router = Router();

/**
 * POST /api/v1/auth/challenge
 * Get authentication nonce
 */
router.post('/challenge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { deviceId, purpose } = req.body;

    if (purpose !== undefined && purpose !== 'challenge') {
      throw createError('Invalid purpose', 400);
    }
    if (typeof deviceId !== 'string' || !deviceId.trim()) {
      throw createError('deviceId is required', 400);
    }
    const nonce = await NonceService.generateNonce();

    const response: ChallengeResponse = {
      nonce,
      ttl: 60,
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
});

export default router;
