import type { ProviderControl } from './modules/security/providerPolicy';
import { createApiLimits, loadSecurityLimits, type SecurityLimitsReader } from './modules/security/securityLimits';
import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { Logger } from 'pino';
import { SecurityTelemetry } from './modules/security/telemetry';
import type { NetworkControl } from './modules/security/networkControl';

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

export function createApp(checks: DependencyChecks, logger: Logger, origin: string, localAdmin?: Router, network?: NetworkControl, limitsReader?: SecurityLimitsReader, providerControl?: ProviderControl, localMobile?: Router) {
  const app = express();
  app.locals.dependencyChecks = checks;
  const telemetry = new SecurityTelemetry();
  app.locals.securityTelemetry = telemetry;
  app.locals.networkControl = network;
  app.locals.providerControl = providerControl;
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
  // Observe completed API responses, including early limiter/origin rejections.
  // No URL, IP, headers, body, account or session identifier enters the collector.
  app.use('/api/v1', (_req, res, next) => {
    res.once('finish', () => telemetry.observe(res.statusCode, res.locals.securitySignal));
    next();
  });
  app.use('/api/v1', rateLimit({
    windowMs: 60_000, limit: 1200, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED' }, requestId: res.locals.requestId }),
  }));
  if (network) app.use('/api/v1', network.guard);
  app.use('/api/v1', loadSecurityLimits(limitsReader), createApiLimits());
  if (localAdmin) app.use('/api/v1/admin', express.json({ limit: '16kb' }), localAdmin);
  if (localMobile) app.use('/api/v1/mobile', express.json({ limit: '16kb' }), localMobile);
  app.use('/api/v1', (_req, res) => res.status(401).json({
    error: { code: 'AUTHENTICATION_REQUIRED' }, requestId: res.locals.requestId,
  }));
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' }, requestId: res.locals.requestId }));
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    const messages: Record<number, string> = { 400: 'Invalid request', 401: 'Invalid credentials', 403: 'Access denied', 428: 'Re-authentication required', 429: 'Too many requests' };
    res.status(status).json({ error: {
      code: status === 500 ? 'INTERNAL_ERROR' : error.code ?? (status === 401 ? 'AUTHENTICATION_REQUIRED' : 'REQUEST_REJECTED'),
      message: status === 500 ? 'Service unavailable' : messages[status] ?? 'Request rejected',
    }, requestId: res.locals.requestId });
  };
  app.use(onError);
  return app;
}
