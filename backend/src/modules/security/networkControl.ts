import { createHmac } from 'node:crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { addressKey, canonicalIP, equalSecret, isLoopback } from './networkIdentity';

export const targetSchema = z
  .object({ key: z.string().regex(/^[a-f0-9]{64}$/), until: z.string().datetime() })
  .strict();
export const networkSettingsSchema = z
  .object({
    mode: z.enum(['off', 'allow', 'deny']),
    countries: z.array(z.string().regex(/^[A-Z]{2}$|^T1$/)).max(250),
    blocked: z.array(targetSchema).max(50),
    exceptions: z.array(targetSchema).max(20),
  })
  .strict();
export type NetworkSettings = z.infer<typeof networkSettingsSchema>;
export interface NetworkControl {
  guard: RequestHandler;
  key: (address: string) => string;
  countryReady: boolean;
}
export function countryDenied(
  settings: NetworkSettings,
  country: string,
  key: string,
  now = Date.now()
) {
  if (settings.blocked.some((row) => row.key === key && Date.parse(row.until) > now)) return true;
  if (settings.exceptions.some((row) => row.key === key && Date.parse(row.until) > now))
    return false;
  if (settings.mode === 'off') return false;
  if (country === 'XX') return true;
  return settings.mode === 'allow'
    ? !settings.countries.includes(country)
    : settings.countries.includes(country);
}
export function createNetworkControl(
  proxySecret: string,
  ipSecret: string,
  readPolicy: () => Promise<{ version: number; settings: NetworkSettings }>,
  countryReady = false
): NetworkControl {
  if (proxySecret.length < 32 || ipSecret.length < 32)
    throw new Error('Network control configuration unavailable');
  const key = (address: string) => addressKey(address, ipSecret);
  const guard: RequestHandler = async (req, res, next) => {
    // The listener is loopback-only. Cloudflare traffic must pass the authenticated Vite hop.
    const peerLocal = isLoopback(req.socket.remoteAddress);
    const directHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host ?? '');
    const hasProxyHeaders = Object.keys(req.headers).some(
      (name) =>
        name.startsWith('cf-') ||
        name.startsWith('x-forwarded-') ||
        name.startsWith('x-ertad-') ||
        name === 'forwarded'
    );
    if (peerLocal && directHost && !hasProxyHeaders) {
      res.locals.networkSource = 'local';
      next();
      return;
    }
    if (!peerLocal || !equalSecret(req.headers['x-ertad-proxy-token'], proxySecret)) {
      res.status(403).json({ error: { code: 'NETWORK_SOURCE_UNTRUSTED' } });
      return;
    }
    if (req.headers['x-ertad-source'] === 'local') {
      res.locals.networkSource = 'local';
      next();
      return;
    }
    try {
      if (req.headers['x-ertad-source'] !== 'cloudflare') throw new Error('Untrusted source');
      const address = canonicalIP(String(req.headers['x-ertad-client-ip'] ?? ''));
      if (isLoopback(address)) throw new Error('Invalid edge address');
      const country = String(req.headers['x-ertad-country'] ?? 'XX');
      if (!/^[A-Z]{2}$|^T1$/.test(country)) throw new Error('Invalid country');
      res.locals.networkSource = 'cloudflare';
      res.locals.networkCountry = country;
      res.locals.networkAddress = address;
      res.locals.networkAddressKey = key(address);
      // Group IPv6 /56 networks for rate budgets; exact-IP blocks keep their separate key.
      res.locals.networkRateKey = createHmac('sha256', ipSecret).update('rate:' + ipKeyGenerator(address)).digest('hex');
      // Own-request country/source only; no address or stable address key is disclosed.
      res.set('X-ERTAD-Network-Source', 'cloudflare').set('X-ERTAD-Network-Country', country);
    } catch {
      res.status(403).json({ error: { code: 'NETWORK_SOURCE_UNTRUSTED' } });
      return;
    }
    try {
      const policy = await readPolicy();
      const settings = networkSettingsSchema.parse(policy.settings);
      if (settings.mode !== 'off' && !countryReady) throw new Error('Country source unavailable');
      if (countryDenied(settings, res.locals.networkCountry, res.locals.networkAddressKey)) {
        res.status(403).json({ error: { code: 'NETWORK_RESTRICTED' } });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: { code: 'NETWORK_POLICY_UNAVAILABLE' } });
    }
  };
  return { guard, key, countryReady };
}
