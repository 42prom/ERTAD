import jwt from 'jsonwebtoken';
import { MemberCredential, DemographicData } from '../types/credentials';
import { getJwtSecret } from '../config/jwt';


const ISSUER = 'ERTAD-identity-service';
const AUDIENCE = 'ertad-member-api';
const MAX_TTL_SECONDS = 24 * 60 * 60;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION = /^[a-zA-Z0-9_-]{1,100}$/;

function validDemographics(value: unknown): value is DemographicData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).every(key => ['age_bucket', 'gender', 'region_codes', 'region', 'citizenship'].includes(key))
    && ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'].includes(data.age_bucket as string)
    && ['M', 'F', 'O'].includes(data.gender as string)
    && data.citizenship === 'GEO'
    && (data.region === undefined || (typeof data.region === 'string' && REGION.test(data.region)))
    && (data.region_codes === undefined || (Array.isArray(data.region_codes)
      && data.region_codes.length <= 32
      && data.region_codes.every(code => typeof code === 'string' && REGION.test(code))));
}

/** Retained enrollment credential. This is not membership, authorization or device evidence. */
export function issueCredentialForSubject(
  subject: string,
  demographics: DemographicData,
  ttlSeconds: number = MAX_TTL_SECONDS
): string {
  if (typeof subject !== 'string' || !USER_ID.test(subject) || !validDemographics(demographics)
    || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error('Invalid member credential input');
  }
  const now = Math.floor(Date.now() / 1000);
  const payload: MemberCredential = {
    iss: ISSUER,
    aud: AUDIENCE,
    token_use: 'member',
    ver: 1,
    sub: subject,
    data: demographics,
    iat: now,
    exp: now + ttlSeconds,
  };

  return jwt.sign(payload, getJwtSecret(), { algorithm: 'HS256' });
}

/**
 * Verify and decode a JWT credential
 */
export function verifyCredential(token: string): MemberCredential {
  try {
    if (typeof token !== 'string' || token.length > 16384) throw new Error('Invalid token');
    const decoded = jwt.verify(token, getJwtSecret(), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      maxAge: MAX_TTL_SECONDS,
    });
    const now = Math.floor(Date.now() / 1000);
    if (typeof decoded === 'string' || decoded.aud !== AUDIENCE || decoded.token_use !== 'member'
      || decoded.ver !== 1 || typeof decoded.sub !== 'string' || !USER_ID.test(decoded.sub)
      || !Number.isSafeInteger(decoded.iat) || !Number.isSafeInteger(decoded.exp)
      || decoded.iat! > now || decoded.exp! <= decoded.iat!
      || decoded.exp! - decoded.iat! > MAX_TTL_SECONDS || !validDemographics(decoded.data)
      || Object.keys(decoded).some(key => !['iss', 'aud', 'token_use', 'ver', 'sub', 'data', 'iat', 'exp'].includes(key))) {
      throw new Error('Invalid claims');
    }
    return decoded as MemberCredential;
  } catch {
    throw new Error('Invalid or expired credential');
  }
}

