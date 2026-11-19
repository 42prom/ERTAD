import { createHmac } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { getApiKeyEncryptionSecret } from '../../config/secrets';
import { encryptSensitiveValue, decryptSensitiveValue } from '../../services/secretEncryption';
import { canonicalIP } from './networkIdentity';

export const providerValues = {
  provider: z.enum(['none', 'iphub']),
  mode: z.enum(['off', 'enforce']),
  blockSuspicious: z.boolean(),
};
export const providerProposalSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().min(0).max(2147483646),
    ...providerValues,
    apiKey: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9+/=_-]+$/)
      .optional(),
    reason: z.enum(['security_tightening', 'provider_change', 'recovery']),
  })
  .strict()
  .refine((v) => v.provider !== 'none' || (v.mode === 'off' && v.apiKey === undefined));
export function protectProviderInput(value: z.infer<typeof providerProposalSchema>) {
  const { apiKey, ...settings } = value;
  return {
    ...settings,
    credentialCipher: apiKey ? encryptSensitiveValue(apiKey) : null,
    credentialDigest: apiKey
      ? createHmac('sha256', getApiKeyEncryptionSecret())
          .update('ertad-provider-credential-v1\0' + apiKey)
          .digest('hex')
      : null,
  };
}
const policySchema = z
  .object({
    version: z.number().int().nonnegative(),
    ...providerValues,
    hasCredential: z.boolean(),
    credentialCipher: z.string().nullable(),
  })
  .strict();
export type ProviderPolicy = z.infer<typeof policySchema>;
export type ProviderReader = () => Promise<unknown>;
export type ProviderLookup = (address: string, apiKey: string) => Promise<0 | 1 | 2>;

/** Fixed HTTPS origin, no redirects, bounded body/time, and no credentials in URLs/errors. */
export const lookupIPHub: ProviderLookup = async (address, apiKey) => {
  const ip = canonicalIP(address);
  const response = await fetch('https://v2.api.iphub.info/ip/' + encodeURIComponent(ip), {
    headers: { 'X-Key': apiKey, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Provider unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) throw new Error('Provider response invalid');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const data = z
    .object({ ip: z.string(), block: z.union([z.literal(0), z.literal(1), z.literal(2)]) })
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (canonicalIP(data.ip) !== ip) throw new Error('Provider response invalid');
  return data.block;
};

export function createProviderControl(read: ProviderReader, lookup: ProviderLookup = lookupIPHub) {
  // Bounded, process-local, one-minute verdict cache. No raw addresses or credentials stored in cache.
  const cache = new Map<string, { value: 0 | 1 | 2; until: number }>();
  const inFlight = new Map<string, Promise<0 | 1 | 2>>();
  const guard: RequestHandler = async (_req, res, next) => {
    // The established loopback recovery route remains available. It never queries a third party.
    if (res.locals.networkSource === 'local') {
      next();
      return;
    }
    try {
      const policy = policySchema.parse(await read());
      if (policy.mode === 'off') {
        next();
        return;
      }
      if (
        policy.provider !== 'iphub' ||
        !policy.hasCredential ||
        !policy.credentialCipher ||
        res.locals.networkSource !== 'cloudflare' ||
        !res.locals.networkAddress ||
        !res.locals.networkAddressKey
      )
        throw new Error('Provider configuration unavailable');
      const key = policy.version + ':' + res.locals.networkAddressKey;
      let verdict = cache.get(key);
      if (!verdict || verdict.until <= Date.now()) {
        let probe = inFlight.get(key);
        if (!probe) {
          if (inFlight.size >= 4) throw new Error('Provider busy');
          const credential = decryptSensitiveValue(policy.credentialCipher);
          probe = lookup(res.locals.networkAddress, credential);
          inFlight.set(key, probe);
        }
        let value: 0 | 1 | 2;
        try {
          value = await probe;
        } finally {
          inFlight.delete(key);
        }
        if (![0, 1, 2].includes(value)) throw new Error('Provider response invalid');
        verdict = { value, until: Date.now() + 60_000 };
        if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
        cache.set(key, verdict);
      }
      // Never accept an old provider decision after a policy change during the lookup.
      const current = policySchema.parse(await read());
      if (current.version !== policy.version) throw new Error('Provider changed');
      if (verdict.value === 1 || (verdict.value === 2 && policy.blockSuspicious)) {
        res.status(403).json({ error: { code: 'NETWORK_RESTRICTED' } });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: { code: 'PROVIDER_UNAVAILABLE' } });
    }
  };
  return { guard };
}
export type ProviderControl = ReturnType<typeof createProviderControl>;
export const requireProviderAccess: RequestHandler = (req, res, next) => {
  const control = req.app.locals.providerControl as ProviderControl | undefined;
  if (control) return control.guard(req, res, next);
  next();
};
