import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { Logger } from 'pino';

export type DependencyChecks = Record<'postgres' | 'redis' | 'storage', () => Promise<unknown>>;

async function healthy(check: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(check),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 2000); }),
    ]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export function createApp(checks: DependencyChecks, logger: Logger, origin: string) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Cache-Control', 'no-store');
    const started = performance.now();
    res.on('finish', () => logger.info({
      requestId, method: req.method, route: req.route?.path ?? 'unmatched',
      status: res.statusCode, durationMs: Math.round(performance.now() - started),
    }, 'request'));
    next();
  });
  app.use(helmet());
  app.use(cors({ origin, methods: ['GET'], credentials: false }));
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    const results = await Promise.all(Object.values(checks).map(healthy));
    const ready = results.every(Boolean);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });
  app.use('/api/v1', rateLimit({
    windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED' }, requestId: res.locals.requestId }),
  }));
  app.use('/api/v1', (_req, res) => res.status(401).json({
    error: { code: 'AUTHENTICATION_REQUIRED' }, requestId: res.locals.requestId,
  }));
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' }, requestId: res.locals.requestId }));
  const onError: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR' }, requestId: res.locals.requestId });
  };
  app.use(onError);
  return app;
}
