import {
  mailProposalSchema,
  protectMailInput,
  validateMailConfiguration,
} from '../src/modules/security/mailPolicy';
import { decryptSensitiveValue } from '../src/services/secretEncryption';
const input = {
  requestId: '00000000-0000-4000-8000-000000000001',
  expectedVersion: 0,
  provider: 'sendgrid' as const,
  mode: 'enabled' as const,
  senderName: 'ERTAD',
  senderEmail: 'sender@example.invalid',
  apiKey: 'SG.synthetic-test-key',
  reason: 'provider_change' as const,
};
const policy = () => ({
  version: 1,
  provider: input.provider,
  mode: input.mode,
  senderName: input.senderName,
  senderEmail: input.senderEmail,
  hasCredential: true,
  credentialCipher: protectMailInput(input).credentialCipher,
});
test('mail configuration validates fields, blocks header injection and unsupported transports', () => {
  expect(mailProposalSchema.safeParse(input).success).toBe(true);
  for (const extra of [
    { senderEmail: 'x@example.invalid\r\nBcc: other@example.invalid' },
    { senderName: 'ERTAD\nOther' },
    { provider: 'smtp' },
    { apiKey: 'bad key' },
    { url: 'https://example.invalid' },
    { mode: 'enabled', senderEmail: '' },
    { provider: 'none' },
  ])
    expect(mailProposalSchema.safeParse({ ...input, ...extra }).success).toBe(false);
});
test('credentials are encrypted and retries have a stable keyed digest', () => {
  const a = protectMailInput(input),
    b = protectMailInput(input);
  expect(a).not.toHaveProperty('apiKey');
  expect(JSON.stringify(a)).not.toContain(input.apiKey);
  expect(a.credentialCipher).not.toBe(b.credentialCipher);
  expect(a.credentialDigest).toBe(b.credentialDigest);
  expect(decryptSensitiveValue(a.credentialCipher!)).toBe(input.apiKey);
});
test('SMTP delivery requires a supported service, username and reviewed HTTPS origin', () => {
  const smtp = {
    ...input,
    provider: 'smtp',
    smtpService: 'gmail',
    smtpUser: 'sender@example.test',
    apiKey: 'app password 123!',
    deliveryEnabled: true,
    publicOrigin: 'https://ertad.example.test',
  };
  expect(mailProposalSchema.safeParse(smtp).success).toBe(true);
  for (const extra of [
    { smtpService: 'custom' },
    { smtpUser: '' },
    { publicOrigin: 'http://ertad.example.test' },
    { publicOrigin: 'https://ertad.example.test/path' },
    { apiKey: 'secret\nheader' },
    { smtpHost: '127.0.0.1' },
  ])
    expect(mailProposalSchema.safeParse({ ...smtp, ...extra }).success).toBe(false);
});
test('off and invalid configurations never contact a provider', async () => {
  const fetcher = jest.fn();
  expect(await validateMailConfiguration({ ...policy(), mode: 'off' }, fetcher)).toBe('off');
  expect(
    await validateMailConfiguration({ ...policy(), credentialCipher: 'invalid' }, fetcher)
  ).toBe('unavailable');
  expect(await validateMailConfiguration({ ...policy(), hasCredential: false }, fetcher)).toBe(
    'unavailable'
  );
  expect(fetcher).not.toHaveBeenCalled();
});
test('sandbox check has fixed origin, no tracking, no real recipient and refuses redirects', async () => {
  const fetcher = jest.fn(async () => new Response('', { status: 200 }));
  expect(await validateMailConfiguration(policy(), fetcher)).toBe('valid');
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
  expect(options.redirect).toBe('error');
  const body = JSON.parse(options.body as string);
  expect(body.mail_settings.sandbox_mode.enable).toBe(true);
  expect(body.personalizations).toEqual([{ to: [{ email: 'diagnostic@example.invalid' }] }]);
  expect(body.tracking_settings.open_tracking.enable).toBe(false);
  expect(body.tracking_settings.click_tracking.enable).toBe(false);
  expect(options.signal).toBeDefined();
});
test('only sandbox success counts; delivery acceptance, errors and timeouts never imply verification', async () => {
  for (const status of [202, 301, 400, 401, 403, 429, 500])
    expect(
      await validateMailConfiguration(
        policy(),
        jest.fn(async () => new Response('private provider error', { status }))
      )
    ).toBe('unavailable');
  const fetcher = jest.fn(async () => {
    throw new Error('secret provider details');
  });
  expect(await validateMailConfiguration(policy(), fetcher)).toBe('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
