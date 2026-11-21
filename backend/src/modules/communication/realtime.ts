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
  router.get('/', async (req, res) => {
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

    const loadAllowedOrgs = async (): Promise<Set<string>> => {
      try {
        const resOrgs = await query<{ organization_id: string }>(
          `SELECT DISTINCT m.organization_id
             FROM ertad.member_users mu
             JOIN ertad.memberships m ON m.user_id = mu.id
             JOIN ertad.organizations o ON o.id = m.organization_id
            WHERE mu.web_account_id = $1
              AND mu.status = 'active'
              AND o.status = 'active'
              AND m.status = 'active'
              AND m.valid_from <= clock_timestamp()
              AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())`,
          [userId]
        );
        return new Set(resOrgs.rows.map((r) => r.organization_id));
      } catch {
        return new Set();
      }
    };

    let allowedOrgIds = await loadAllowedOrgs();
    if (req.destroyed || res.writableEnded) {
      const cnt = activeStreamsByUser.get(userId) ?? 1;
      if (cnt <= 1) activeStreamsByUser.delete(userId);
      else activeStreamsByUser.set(userId, cnt - 1);
      return;
    }

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

    const onSignal = (signal: RealtimeSignal) => {
      // Tenant isolation (I9): never forward another organization's realtime invalidations.
      if (!signal.organizationId || !allowedOrgIds.has(signal.organizationId)) return;
      writeFrame('invalidate', signal);
    };
    bus.on('invalidate', onSignal);

    writeFrame('ready', { at: new Date().toISOString() });

    const pingTimer = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    pingTimer.unref();

    const sessionTimer = setInterval(() => {
      if (closed) return;
      void Promise.all([
        query<{ valid: boolean }>(
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
               AND NOT ertad.web_account_held(a.id)
               AND (a.locked_until IS NULL OR a.locked_until <= clock_timestamp())
           ) AS valid`,
          [session.sessionId, session.sessionTokenHash]
        ),
        loadAllowedOrgs(),
      ])
        .then(([result, refreshedOrgs]) => {
          allowedOrgIds = refreshedOrgs;
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

