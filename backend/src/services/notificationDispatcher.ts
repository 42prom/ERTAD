import { pool } from '../db/client';
import { decryptSensitiveValue } from './secretEncryption';

export type DispatchChannel = 'push' | 'telegram' | 'whatsapp' | 'viber';

export interface ClaimedDelivery {
  deliveryId: string;
  outboxId: string;
  channel: DispatchChannel;
  attempts: number;
  kind: string;
  title: string;
  handleCipher: string | null;
  publicConfig: Record<string, string> | null;
  secretCipher: string | null;
}

export interface HttpDispatchRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpDispatchResponse {
  ok: boolean;
  status: number;
}

export type HttpDispatchTransport = (
  req: HttpDispatchRequest
) => Promise<HttpDispatchResponse>;

export interface DispatchSummary {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

const defaultTransport: HttpDispatchTransport = async (req) => {
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: req.body,
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  return { ok: res.ok, status: res.status };
};

/**
 * Builds a strict, fixed-host HTTPS request for the target notification channel.
 * Secrets and member handles are decrypted only in memory and never logged.
 */
export function buildChannelRequest(
  item: ClaimedDelivery,
  secret: string,
  handle: string
): HttpDispatchRequest | null {
  const cfg = item.publicConfig ?? {};
  // I14 mandatory third-party notification privacy: never transmit domain titles externally by default.
  const text = 'You have a new notification in ERTAD.';

  switch (item.channel) {
    case 'telegram': {
      if (!secret || !handle) return null;
      return {
        url: `https://api.telegram.org/bot${encodeURIComponent(secret)}/sendMessage`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: handle,
          text,
          disable_web_page_preview: true,
        }),
      };
    }
    case 'whatsapp': {
      const phoneNumberId = (cfg.phoneNumberId ?? '').trim();
      if (!secret || !handle || !/^[0-9]{5,30}$/.test(phoneNumberId)) return null;
      return {
        url: `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: handle.replace(/[^0-9+]/g, ''),
          type: 'text',
          text: { body: text, preview_url: false },
        }),
      };
    }
    case 'viber': {
      if (!secret || !handle) return null;
      const senderName = (cfg.senderName ?? 'ERTAD').trim().slice(0, 28) || 'ERTAD';
      return {
        url: 'https://chatapi.viber.com/pa/send_message',
        headers: {
          'Content-Type': 'application/json',
          'X-Viber-Auth-Token': secret,
        },
        body: JSON.stringify({
          receiver: handle,
          type: 'text',
          sender: { name: senderName },
          text,
        }),
      };
    }
    case 'push': {
      const projectId = (cfg.projectId ?? '').trim();
      if (!secret || !handle || !/^[a-z0-9-]{4,64}$/.test(projectId)) return null;
      return {
        url: `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          message: {
            token: handle,
            notification: {
              title: 'ERTAD',
              body: text,
            },
            data: {
              kind: item.kind,
              outboxId: item.outboxId,
            },
          },
        }),
      };
    }
  }
}

export async function dispatchSingleDelivery(
  item: ClaimedDelivery,
  transport: HttpDispatchTransport = defaultTransport
): Promise<{ outcome: 'sent' | 'retry' | 'failed' | 'skipped'; error?: string; retrySeconds?: number }> {
  if (!item.secretCipher) {
    return { outcome: 'skipped', error: 'PROVIDER_SECRET_MISSING' };
  }
  let secret = '';
  let handle = '';
  try {
    secret = decryptSensitiveValue(item.secretCipher);
    handle = item.handleCipher ? decryptSensitiveValue(item.handleCipher) : '';
  } catch {
    return { outcome: 'failed', error: 'CREDENTIAL_DECRYPT_FAILED' };
  }

  const req = buildChannelRequest(item, secret, handle);
  if (!req) {
    return { outcome: 'skipped', error: 'CHANNEL_CONFIG_OR_HANDLE_INCOMPLETE' };
  }

  try {
    const res = await transport(req);
    if (res.ok) {
      return { outcome: 'sent' };
    }
    if (res.status === 429 || res.status >= 500) {
      const retrySeconds = Math.min(3600, 30 * Math.pow(2, Math.max(0, item.attempts - 1)));
      return { outcome: 'retry', error: `HTTP_${res.status}`, retrySeconds };
    }
    return { outcome: 'failed', error: `HTTP_${res.status}` };
  } catch {
    const retrySeconds = Math.min(3600, 30 * Math.pow(2, Math.max(0, item.attempts - 1)));
    return { outcome: 'retry', error: 'NETWORK_ERROR', retrySeconds };
  }
}

/**
 * Claims due outbox channel deliveries via PostgreSQL SKIP LOCKED and dispatches them.
 */
export async function dispatchPendingNotifications(
  limit = 20,
  transport: HttpDispatchTransport = defaultTransport
): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
  };

  const claimRes = await pool.query<{ items: ClaimedDelivery[] }>(
    'SELECT ertad.claim_notification_deliveries($1) AS items',
    [limit]
  );
  const items = claimRes.rows[0]?.items ?? [];
  summary.claimed = items.length;

  for (const item of items) {
    const result = await dispatchSingleDelivery(item, transport);
    await pool.query(
      'SELECT ertad.complete_notification_delivery($1, $2, $3, $4)',
      [item.deliveryId, result.outcome, result.error ?? '', result.retrySeconds ?? 60]
    );
    if (result.outcome === 'sent') summary.sent++;
    else if (result.outcome === 'retry') summary.retried++;
    else if (result.outcome === 'skipped') summary.skipped++;
    else summary.failed++;
  }

  return summary;
}

/**
 * Starts a non-overlapping background notification dispatcher loop.
 * Returns a stop() handle for clean shutdown.
 */
export function startNotificationDispatcher(intervalMs = 15000): () => void {
  let active = true;
  let running = false;

  const timer = setInterval(async () => {
    if (!active || running) return;
    running = true;
    try {
      await dispatchPendingNotifications(20);
    } catch {
      // Transient DB errors are retried on next tick without leaking secrets.
    } finally {
      running = false;
    }
  }, intervalMs);

  timer.unref?.();
  return () => {
    active = false;
    clearInterval(timer);
  };
}
