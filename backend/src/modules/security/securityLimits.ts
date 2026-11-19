import type { RequestHandler, Response, Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';

export const securityLimitsValues = {
  apiPerMinute: z.number().int().min(60).max(600),
  loginFailures: z.number().int().min(3).max(10),
  lockoutMinutes: z.number().int().min(5).max(60),
  anonymousMinElectorate: z.number().int().min(2).max(1000).optional(),
};
export const securityLimitsSchema = z
  .object({
    version: z.number().int().min(0),
    ...securityLimitsValues,
  })
  .strict();
export type SecurityLimits = z.infer<typeof securityLimitsSchema>;
export const defaultSecurityLimits: Readonly<SecurityLimits> = Object.freeze({
  version: 0,
  apiPerMinute: 120,
  loginFailures: 5,
  lockoutMinutes: 15,
  anonymousMinElectorate: 10,
});
export type SecurityLimitsReader = () => Promise<unknown>;
export function requestSecurityLimits(res: Response): Readonly<SecurityLimits> {
  return res.locals.securityLimits ?? defaultSecurityLimits;
}
// Only the authenticated network guard can populate this fingerprint.
// Direct requests use the socket peer; untrusted forwarded headers never form a key.
export function rateLimitKey(req: Request, res: Response): string {
  if (res.locals.networkSource === 'cloudflare' && typeof res.locals.networkRateKey === 'string')
    return 'edge:' + res.locals.networkRateKey;
  return 'peer:' + ipKeyGenerator(req.socket.remoteAddress ?? 'unknown');
}
export function loadSecurityLimits(read?: SecurityLimitsReader): RequestHandler {
  return async (_req, res, next) => {
    try {
      res.locals.securityLimits = read
        ? securityLimitsSchema.parse(await read())
        : defaultSecurityLimits;
      next();
    } catch {
      res
        .status(503)
        .json({ error: { code: 'SECURITY_LIMITS_UNAVAILABLE' }, requestId: res.locals.requestId });
    }
  };
}
export function createApiLimits() {
  return rateLimit({
    windowMs: 60_000,
    limit: (_req, res) => requestSecurityLimits(res).apiPerMinute,
    keyGenerator: rateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED' }, requestId: res.locals.requestId }),
  });
}
export function createLoginLimits() {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: (_req, res) => requestSecurityLimits(res).loginFailures,
    keyGenerator: rateLimitKey,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED' }, requestId: res.locals.requestId }),
  });
}
