import nodemailer from 'nodemailer';
import { sendSecurityMail } from '../src/modules/identity/mailTransport';
import { validateMailConfiguration } from '../src/modules/security/mailPolicy';
import { encryptSensitiveValue } from '../src/services/secretEncryption';
const policy = {
  version: 1,
  provider: 'sendgrid',
  mode: 'enabled',
  deliveryEnabled: true,
  publicOrigin: 'https://ertad.example.test',
  smtpService: 'sendgrid',
  smtpUser: '',
  senderName: 'ERTAD',
  senderEmail: 'sender@example.test',
  hasCredential: true,
  credentialCipher: encryptSensitiveValue('SG.synthetic-key'),
};
const message = {
  id: '00000000-0000-4000-8000-000000000001',
  purpose: 'contact',
  email: 'recipient@example.test',
  token: 'a'.repeat(43),
};
test('real delivery is explicit, fixed-origin and tracking-free with a fragment credential', async () => {
  const fetcher = jest.fn(async () => new Response('', { status: 202 }));
  expect(await sendSecurityMail(policy, message, fetcher)).toBe('accepted');
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
  expect(options.redirect).toBe('error');
  const data = JSON.parse(options.body as string);
  expect(data.mail_settings).toBeUndefined();
  expect(data.tracking_settings.open_tracking.enable).toBe(false);
  expect(data.content[0].value).toContain(
    'https://ertad.example.test/verify-email#' + message.id + '.' + message.token
  );
  expect(data).not.toHaveProperty('custom_args');
  expect(data).not.toHaveProperty('attachments');
});
test('off policy never sends and malformed recipients cannot inject headers', async () => {
  const fetcher = jest.fn();
  expect(await sendSecurityMail({ ...policy, deliveryEnabled: false }, message, fetcher)).toBe(
    'failed'
  );
  await sendSecurityMail(
    policy,
    { ...message, email: 'x@example.test\r\nBcc:y@example.test' },
    fetcher
  );
  expect(fetcher).not.toHaveBeenCalled();
});

test('email-change proof has its own route; old-address notice contains no credential or action', async () => {
  const fetcher = jest.fn(async () => new Response('', { status: 202 }));
  await sendSecurityMail(policy, { ...message, purpose: 'email_change' }, fetcher);
  const proof = JSON.parse(
    (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
  );
  expect(proof.content[0].value).toContain(
    '/verify-email-change#' + message.id + '.' + message.token
  );
  await sendSecurityMail(policy, { ...message, purpose: 'email_changed' }, fetcher);
  const notice = JSON.parse(
    (fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string
  );
  expect(notice.content[0].value).toContain('https://ertad.example.test/account');
  expect(notice.content[0].value).not.toContain(message.id);
  expect(notice.content[0].value).not.toContain(message.token);
  expect(notice.content[0].value).not.toContain('verify-email-change');
  expect(notice.content[0].value).not.toContain('ignore');
});
test('only explicit provider rejection can retry; timeouts and 5xx are uncertain', async () => {
  for (const [status, result] of [
    [202, 'accepted'],
    [429, 'retry'],
    [400, 'failed'],
    [403, 'failed'],
    [500, 'uncertain'],
    [200, 'uncertain'],
  ] as const)
    expect(
      await sendSecurityMail(
        policy,
        message,
        jest.fn(async () => new Response('', { status }))
      )
    ).toBe(result);
  const fetcher = jest.fn(async () => {
    throw Error('timeout containing secret');
  });
  expect(await sendSecurityMail(policy, message, fetcher)).toBe('uncertain');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('SMTP uses a fixed service, required TLS, bounded timeouts and no resource access', async () => {
  const verify = jest.fn(async () => true),
    sendMail = jest.fn(async () => ({ accepted: ['recipient@example.test'] })),
    close = jest.fn();
  const create = jest
    .spyOn(nodemailer, 'createTransport')
    .mockReturnValue({ verify, sendMail, close } as never);
  try {
    const smtp = {
      ...policy,
      provider: 'smtp',
      smtpService: 'gmail',
      smtpUser: 'sender@example.test',
    };
    expect(await validateMailConfiguration(smtp)).toBe('valid');
    expect(sendMail).not.toHaveBeenCalled();
    expect(await sendSecurityMail(smtp, message)).toBe('accepted');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        requireTLS: true,
        disableFileAccess: true,
        disableUrlAccess: true,
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      })
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    create.mockRestore();
  }
});
