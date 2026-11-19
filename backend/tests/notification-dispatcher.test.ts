import {
  dispatchSingleDelivery,
  type ClaimedDelivery,
  type HttpDispatchRequest,
} from '../src/services/notificationDispatcher';
import { encryptSensitiveValue } from '../src/services/secretEncryption';

describe('Multi-Channel Notification Outbox Dispatcher', () => {
  const base: Omit<ClaimedDelivery, 'channel' | 'publicConfig' | 'secretCipher' | 'handleCipher'> = {
    deliveryId: '11111111-1111-4111-8111-111111111111',
    outboxId: '22222222-2222-4222-8222-222222222222',
    attempts: 1,
    kind: 'decision',
    title: 'ახალი კენჭისყრა გაიხსნა',
  };

  it('dispatches Telegram, WhatsApp, Viber, and FCM Push with decrypted credentials and fixed HTTPS hosts', async () => {
    const captured: HttpDispatchRequest[] = [];
    const okTransport = async (req: HttpDispatchRequest) => {
      captured.push(req);
      return { ok: true, status: 200 };
    };

    const cases: ClaimedDelivery[] = [
      {
        ...base,
        channel: 'telegram',
        publicConfig: { botUsername: '@ertad_bot' },
        secretCipher: encryptSensitiveValue('tg-bot-secret-123'),
        handleCipher: encryptSensitiveValue('987654321'),
      },
      {
        ...base,
        channel: 'whatsapp',
        publicConfig: { phoneNumberId: '1029384756' },
        secretCipher: encryptSensitiveValue('wa-meta-token-456'),
        handleCipher: encryptSensitiveValue('+995599112233'),
      },
      {
        ...base,
        channel: 'viber',
        publicConfig: { senderName: 'ERTAD' },
        secretCipher: encryptSensitiveValue('viber-auth-789'),
        handleCipher: encryptSensitiveValue('viber-user-id-abc'),
      },
      {
        ...base,
        channel: 'push',
        publicConfig: { projectId: 'ertad-prod-01' },
        secretCipher: encryptSensitiveValue('fcm-oauth-token-000'),
        handleCipher: encryptSensitiveValue('fcm-device-token-xyz'),
      },
    ];

    for (const item of cases) {
      const res = await dispatchSingleDelivery(item, okTransport);
      expect(res.outcome).toBe('sent');
    }

    expect(captured).toHaveLength(4);
    expect(captured[0].url).toBe('https://api.telegram.org/bottg-bot-secret-123/sendMessage');
    expect(JSON.parse(captured[0].body)).toMatchObject({ chat_id: '987654321' });

    expect(captured[1].url).toBe('https://graph.facebook.com/v20.0/1029384756/messages');
    expect(captured[1].headers.Authorization).toBe('Bearer wa-meta-token-456');

    expect(captured[2].url).toBe('https://chatapi.viber.com/pa/send_message');
    expect(captured[2].headers['X-Viber-Auth-Token']).toBe('viber-auth-789');

    expect(captured[3].url).toBe('https://fcm.googleapis.com/v1/projects/ertad-prod-01/messages:send');
    expect(captured[3].headers.Authorization).toBe('Bearer fcm-oauth-token-000');
  });

  it('retries with exponential backoff on 5xx/429 and fails permanently on 4xx without leaking secrets', async () => {
    const item: ClaimedDelivery = {
      ...base,
      channel: 'telegram',
      attempts: 2,
      publicConfig: {},
      secretCipher: encryptSensitiveValue('super-secret-token'),
      handleCipher: encryptSensitiveValue('@member_private'),
    };

    const retryRes = await dispatchSingleDelivery(item, async () => ({ ok: false, status: 503 }));
    expect(retryRes.outcome).toBe('retry');
    expect(retryRes.error).toBe('HTTP_503');
    expect(retryRes.retrySeconds).toBe(60);
    expect(retryRes.error).not.toContain('super-secret-token');

    const failRes = await dispatchSingleDelivery(item, async () => ({ ok: false, status: 400 }));
    expect(failRes.outcome).toBe('failed');
    expect(failRes.error).toBe('HTTP_400');
  });
});
