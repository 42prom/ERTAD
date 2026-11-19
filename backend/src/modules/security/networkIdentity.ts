import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function canonicalIP(value: string): string {
  if (!isIP(value)) throw new Error('Invalid address');
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (mapped) {
    const a = parseInt(mapped[1], 16),
      b = parseInt(mapped[2], 16);
    return [a >> 8, a & 255, b >> 8, b & 255].join('.');
  }
  return normalized;
}
export function isLoopback(value: string | undefined) {
  try {
    const ip = canonicalIP(value ?? '');
    return ip === '::1' || ip.startsWith('127.');
  } catch {
    return false;
  }
}
export function equalSecret(value: unknown, expected: string) {
  if (typeof value !== 'string' || !expected || value.length !== expected.length) return false;
  const supplied = Buffer.from(value),
    wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}
export function addressKey(address: string, secret: string) {
  if (secret.length < 32) throw new Error('Network address key unavailable');
  return createHmac('sha256', secret)
    .update('ertad-network-address-v1\0' + canonicalIP(address))
    .digest('hex');
}
