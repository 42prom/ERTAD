import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { query } from '../../db/client';
import { requireAdmin } from '../../middleware/auth';

export type RealtimeTopic =
  | 'workspace'
  | 'inbox'
  | 'channel'
  | 'work'
  | 'event'
  | 'decision'
  | 'review'
  | 'unit'
  | 'collective';

export interface RealtimeSignal {
  topic: RealtimeTopic;
  organizationId?: string;
  channelId?: string;
  at: string;
}

const CHANNEL_NAME = 'ertad:realtime:invalidate';
const MAX_STREAMS_PER_USER = 5;
const HEARTBEAT_MS = 25_000;
const SESSION_RECHECK_MS = 30_000;
const instanceId = randomUUID();
const bus = new EventEmitter();
bus.setMaxListeners(200);

type RedisPublishFn = (message: string) => void;
let redisPublish: RedisPublishFn | undefined;

export function attachRealtimeRedis(
  publishFn: RedisPublishFn
): (rawMessage: string) => void {
  redisPublish = publishFn;
  return (rawMessage: string) => {
    try {
      const parsed = JSON.parse(rawMessage) as {
        source?: string;
        signal?: RealtimeSignal;
      };
      if (!parsed || parsed.source === instanceId || !parsed.signal?.topic) return;
      bus.emit('invalidate', parsed.signal);
    } catch {
      // Ignore malformed pubsub frames safely.
    }
  };
}

export function publishRealtimeSignal(signal: Omit<RealtimeSignal, 'at'>): void {
  const payload: RealtimeSignal = {
    topic: signal.topic,
    ...(signal.organizationId ? { organizationId: signal.organizationId } : {}),
    ...(signal.channelId ? { channelId: signal.channelId } : {}),
    at: new Date().toISOString(),
  };
  bus.emit('invalidate', payload);
  if (redisPublish) {
    try {
      redisPublish(JSON.stringify({ source: instanceId, signal: payload }));
    } catch {
      // Local in-process delivery already occurred; never fail domain mutations.
    }
  }
}

export function createRealtimeRouter(allowedOrigins?: Set<string>): Router {
  const router = Router();
  const activeStreamsByUser = new Map<string, number>();

  router.use(requireAdmin);
  router.get('/', (req, res) => {
    const requestOrigin = req.get('origin');
    if (requestOrigin && allowedOrigins && !allowedOrigins.has(requestOrigin)) {
      res.status(403).json({
        error: { code: 'ORIGIN_REJECTED', message: 'Request origin is not allowed' },
      });
      return;
    }

    const userId = req.adminUser!.id;
    const session = req.adminSession!;
    const currentCount = activeStreamsByUser.get(userId) ?? 0;
    if (currentCount >= MAX_STREAMS_PER_USER) {
      res.status(429).json({
        error: { code: 'STREAM_LIMIT_EXCEEDED', message: 'Too many active realtime streams' },
      });
      return;
    }
    activeStreamsByUser.set(userId, currentCount + 1);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    const writeFrame = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onSignal = (signal: RealtimeSignal) => writeFrame('invalidate', signal);
    bus.on('invalidate', onSignal);

    writeFrame('ready', { at: new Date().toISOString() });

    const pingTimer = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    pingTimer.unref();

    const sessionTimer = setInterval(() => {
      if (closed) return;
      void query<{ valid: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM ertad.admin_sessions s
           JOIN ertad.admin_users a ON a.id = s.admin_user_id
           WHERE s.id = $1
             AND s.token_hash = $2
             AND s.revoked_at IS NULL
             AND s.idle_expires_at > clock_timestamp()
             AND s.absolute_expires_at > clock_timestamp()
             AND a.is_active
             AND (a.locked_until IS NULL OR a.locked_until <= clock_timestamp())
         ) AS valid`,
        [session.sessionId, session.sessionTokenHash]
      )
        .then((result) => {
          if (!result.rows[0]?.valid) {
            writeFrame('session_ended', {});
            cleanup();
          }
        })
        .catch(() => {
          // Transient query errors do not immediately terminate healthy connections.
        });
    }, SESSION_RECHECK_MS);
    sessionTimer.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      clearInterval(sessionTimer);
      bus.off('invalidate', onSignal);
      const count = activeStreamsByUser.get(userId) ?? 1;
      if (count <= 1) activeStreamsByUser.delete(userId);
      else activeStreamsByUser.set(userId, count - 1);
      if (!res.writableEnded) res.end();
    };

    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  return router;
}

export const REALTIME_REDIS_CHANNEL = CHANNEL_NAME;

