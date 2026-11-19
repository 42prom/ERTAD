import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import { getJwtSecret } from '../src/config/jwt';
import { issueCredentialForSubject, verifyCredential } from '../src/services/credentials';
import { DemographicData } from '../src/types/credentials';
import authRouter from '../src/routes/auth';

jest.mock('../src/services/nonce', () => ({ __esModule: true, default: { generateNonce: jest.fn() } }));

const subject = '00000000-0000-4000-8000-000000000001';
const demographics: DemographicData = { age_bucket: '25-34', gender: 'O', citizenship: 'GEO' };
const now = 1791072000;
const claims = () => ({
  iss: 'ERTAD-identity-service', aud: 'ertad-member-api', token_use: 'member', ver: 1,
  sub: subject, data: demographics, iat: now, exp: now + 3600,
});

describe('member credential boundary', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now * 1000));
  afterEach(() => jest.restoreAllMocks());

  it('issues a bounded, typed credential for an opaque user and roundtrips demographic buckets', () => {
    const result = verifyCredential(issueCredentialForSubject(subject, demographics, 3600));
    expect(result).toEqual(claims());
    expect(result).not.toHaveProperty('role');
    expect(verifyCredential(issueCredentialForSubject(subject, demographics)).exp).toBe(now + 86400);
  });

  it.each([
    ['wrong issuer', { iss: 'other-service' }],
    ['wrong audience', { aud: 'ertad-admin-api' }],
    ['multiple audiences', { aud: ['ertad-member-api', 'ertad-admin-api'] }],
    ['admin token', { token_use: 'admin' }],
    ['unknown version', { ver: 2 }],
    ['document hash as subject', { sub: 'a'.repeat(64) }],
    ['missing subject', { sub: undefined }],
    ['missing token class', { token_use: undefined }],
    ['missing expiry', { exp: undefined }],
    ['missing issued-at', { iat: undefined }],
    ['future issued-at', { iat: now + 1 }],
    ['expired', { exp: now }],
    ['oversized lifetime', { exp: now + 86401 }],
    ['fractional expiry', { exp: now + 100.5 }],
    ['privilege claims', { role: 'superadmin' }],
    ['missing demographics', { data: undefined }],
    ['unexpected identity fields', { data: { ...demographics, documentNumber: 'synthetic' } }],
    ['invalid demographic bucket', { data: { ...demographics, age_bucket: 'unknown' } }],
    ['malformed regions', { data: { ...demographics, region_codes: [null] } }],
  ])('rejects %s even with a valid signature', (_name, patch) => {
    const payload = JSON.parse(JSON.stringify({ ...claims(), ...patch }));
    // jsonwebtoken adds iat unless explicitly suppressed.
    const token = jwt.sign(payload, getJwtSecret(), { algorithm: 'HS256', noTimestamp: !payload.iat });
    expect(() => verifyCredential(token)).toThrow('Invalid or expired credential');
  });

  it.each(['HS384', 'HS512', 'none'] as const)('rejects the %s algorithm', algorithm => {
    const token = algorithm === 'none'
      ? jwt.sign(claims(), null, { algorithm })
      : jwt.sign(claims(), getJwtSecret(), { algorithm });
    expect(() => verifyCredential(token)).toThrow('Invalid or expired credential');
  });

  it('rejects tampering without logging the credential or decoder error', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const token = jwt.sign(claims(), 'synthetic-wrong-key');
    expect(() => verifyCredential(token)).toThrow('Invalid or expired credential');
    expect(() => verifyCredential('x'.repeat(16385))).toThrow('Invalid or expired credential');
    expect(log).not.toHaveBeenCalled();
  });

  it.each([0, -1, 86401, 0.5, NaN, Infinity])('will not issue an invalid lifetime %s', ttl => {
    expect(() => issueCredentialForSubject(subject, demographics, ttl)).toThrow('Invalid member credential input');
  });

  it('will not issue credentials for document hashes or arbitrary private fields', () => {
    expect(() => issueCredentialForSubject('a'.repeat(64), demographics)).toThrow();
    expect(() => issueCredentialForSubject(subject, { ...demographics, name: 'synthetic' } as DemographicData)).toThrow();
  });

  it('does not expose the obsolete generic JWT verification / identity-hash endpoint', async () => {
    const app = express();
    app.use(express.json());
    app.use('/auth', authRouter);
    const response = await request(app).post('/auth/session/verify')
      .send({ sessionAttestation: issueCredentialForSubject(subject, demographics) });
    expect(response.status).toBe(404);
    expect(response.body).not.toHaveProperty('pnHash');
    expect(response.body).not.toHaveProperty('valid');
  });
});
