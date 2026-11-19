import { z } from 'zod';
import { effectiveMailSchema, smtpTransport } from '../security/mailPolicy';
import { decryptSensitiveValue } from '../../services/secretEncryption';
export type DeliveryOutcome = 'accepted' | 'retry' | 'failed' | 'uncertain';
const messageSchema = z
  .object({
    email: z.string().email().max(254),
    id: z.string().uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    purpose: z.enum(['contact', 'invitation', 'recovery','email_change','email_changed']),
  })
  .strict();
/** Only server-selected security messages. No templates, attachments or caller URLs. */
export async function sendSecurityMail(
  config: unknown,
  input: unknown,
  fetcher: typeof fetch = fetch
): Promise<DeliveryOutcome> {
  let transport: ReturnType<typeof smtpTransport> | undefined;
  try {
    const policy = effectiveMailSchema.parse(config),
      message = messageSchema.parse(input);
    if (
      policy.mode !== 'enabled' ||
      !policy.deliveryEnabled ||
      !policy.publicOrigin ||
      !policy.credentialCipher ||
      !policy.senderEmail
    )
      return 'failed';
    const route = { contact: 'verify-email', invitation: 'activate', recovery: 'recover',email_change:'verify-email-change',email_changed:'account' }[
      message.purpose
    ];
    const url = policy.publicOrigin + '/' + route + (message.purpose==='email_changed'?'':'#' + message.id + '.' + message.token);
    const text =
      'ERTAD\n\n' +
      {
        contact: 'დაადასტურეთ ელფოსტის მისამართი / Confirm your email address.',
        invitation: 'გააქტიურეთ თქვენი ანგარიში / Activate your account.',
        recovery: 'პაროლის აღდგენა / Reset your password.',
        email_change:'დაადასტურეთ შესვლის ელფოსტის შეცვლა. ჯერ შედით თქვენს ანგარიშში. / Confirm your sign-in email change. Sign in to your own account first.',
        email_changed:'თქვენი ERTAD ანგარიშის შესვლის ელფოსტა შეიცვალა. თუ ცვლილება არ მოგითხოვიათ, მიმართეთ მხარდაჭერას თქვენთვის ცნობილ არხზე. / Your ERTAD sign-in email was changed. If you did not request this, contact support through a known channel.',
      }[message.purpose] +
      '\n\n' +
      url +
      (message.purpose==='email_changed'?'':'\n\nთუ ეს მოთხოვნა არ გიცნობთ, უგულებელყავით წერილი. / If you did not expect this request, ignore this email. Opening the link does not perform the action.');
    if (policy.provider === 'smtp') {
      transport = smtpTransport(policy);
      const result = await transport.sendMail({
        from: { name: policy.senderName || 'ERTAD', address: policy.senderEmail },
        to: { address: message.email, name: '' },
        subject: 'ERTAD — account security',
        text,
      });
      return result.accepted?.length === 1 ? 'accepted' : 'failed';
    }
    if (policy.provider !== 'sendgrid') return 'failed';
    const response = await fetcher('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: 'Bearer ' + decryptSensitiveValue(policy.credentialCipher),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.email }] }],
        from: { email: policy.senderEmail, name: policy.senderName || 'ERTAD' },
        subject: 'ERTAD — account security',
        content: [{ type: 'text/plain', value: text }],
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
          subscription_tracking: { enable: false },
        },
      }),
    });
    await response.body?.cancel();
    if (response.status === 202) return 'accepted';
    if (response.status === 429) return 'retry';
    return response.status >= 400 && response.status < 500 ? 'failed' : 'uncertain';
  } catch (error) {
    // An SMTP 4xx response explicitly rejects acceptance. Network errors may follow delivery.
    const code = (error as { responseCode?: number }).responseCode;
    return code && code >= 400 && code < 500
      ? 'retry'
      : code && code >= 500 && code < 600
        ? 'failed'
        : 'uncertain';
  } finally {
    transport?.close();
  }
}
