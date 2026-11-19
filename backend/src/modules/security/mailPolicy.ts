import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { getApiKeyEncryptionSecret } from '../../config/secrets';
import { encryptSensitiveValue, decryptSensitiveValue } from '../../services/secretEncryption';
import nodemailer from 'nodemailer';

const address = z
  .string()
  .max(254)
  .regex(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/);
export const mailValues = {
  provider: z.enum(['none', 'sendgrid', 'smtp']),
  mode: z.enum(['off', 'enabled']),
  deliveryEnabled: z.boolean().default(false),
  publicOrigin: z
    .string()
    .max(260)
    .regex(/^$|^https:\/\/[a-z0-9][a-z0-9.-]*[a-z0-9]$/)
    .default(''),
  smtpService: z.enum(['sendgrid', 'gmail', 'office365']).default('sendgrid'),
  smtpUser: z
    .string()
    .max(254)
    .regex(/^[^\x00-\x1f\x7f]*$/)
    .default(''),
  senderName: z
    .string()
    .max(80)
    .regex(/^[^\x00-\x1f\x7f]*$/),
  senderEmail: z.union([z.literal(''), address]),
};
export const mailProposalSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().min(0).max(2147483646),
    ...mailValues,
    apiKey: z
      .string()
      .min(10)
      .max(256)
      .regex(/^[^\x00-\x1f\x7f]+$/)
      .optional(),
    reason: z.enum(['security_tightening', 'provider_change', 'recovery']),
  })
  .strict()
  .refine((v) => v.provider !== 'none' || (v.mode === 'off' && v.apiKey === undefined))
  .refine((v) => v.mode === 'off' || v.senderEmail !== '')
  .refine((v) => !v.deliveryEnabled || (v.mode === 'enabled' && v.publicOrigin !== ''))
  .refine((v) => v.provider !== 'smtp' || v.mode === 'off' || v.smtpUser !== '')
  .refine((v) => v.provider !== 'sendgrid' || !v.apiKey || /^[A-Za-z0-9._-]+$/.test(v.apiKey));

export function protectMailInput(value: z.input<typeof mailProposalSchema>) {
  const { apiKey, ...settings } = mailProposalSchema.parse(value);
  return {
    ...settings,
    credentialCipher: apiKey ? encryptSensitiveValue(apiKey) : null,
    credentialDigest: apiKey
      ? createHmac('sha256', getApiKeyEncryptionSecret())
          .update('ertad-mail-credential-v1\0' + apiKey)
          .digest('hex')
      : null,
  };
}
export const effectiveMailSchema = z
  .object({
    version: z.number().int().nonnegative(),
    ...mailValues,
    hasCredential: z.boolean(),
    credentialCipher: z.string().nullable(),
  })
  .strict();
export type MailDiagnostic = 'valid' | 'unavailable' | 'off';
export function smtpTransport(policy: z.infer<typeof effectiveMailSchema>) {
  if (policy.provider !== 'smtp' || !policy.credentialCipher || !policy.smtpUser)
    throw Error('SMTP unavailable');
  const hosts = {
    sendgrid: 'smtp.sendgrid.net',
    gmail: 'smtp.gmail.com',
    office365: 'smtp.office365.com',
  };
  return nodemailer.createTransport({
    host: hosts[policy.smtpService],
    port: 587,
    secure: false,
    requireTLS: true,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    auth: { user: policy.smtpUser, pass: decryptSensitiveValue(policy.credentialCipher) },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

/** Provider sandbox validation only. Never sends a message or accepts a caller destination/body. */
export async function validateMailConfiguration(
  value: unknown,
  fetcher: typeof fetch = fetch
): Promise<MailDiagnostic> {
  try {
    const policy = effectiveMailSchema.parse(value);
    if (policy.mode === 'off') return 'off';
    if (policy.provider === 'smtp') {
      const transport = smtpTransport(policy);
      try {
        await transport.verify();
        return 'valid';
      } finally {
        transport.close();
      }
    }
    if (
      policy.provider !== 'sendgrid' ||
      !policy.hasCredential ||
      !policy.credentialCipher ||
      !policy.senderEmail
    )
      return 'unavailable';
    const key = decryptSensitiveValue(policy.credentialCipher);
    const response = await fetcher('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: 'diagnostic@example.invalid' }] }],
        from: { email: policy.senderEmail, name: policy.senderName || 'ERTAD' },
        subject: 'ERTAD configuration validation',
        content: [
          {
            type: 'text/plain',
            value: 'Configuration validation only. No message delivery requested.',
          },
        ],
        mail_settings: { sandbox_mode: { enable: true } },
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
          subscription_tracking: { enable: false },
        },
      }),
    });
    await response.body?.cancel();
    // Sandbox success is 200, not the 202 used for real mail acceptance.
    return response.status === 200 ? 'valid' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
