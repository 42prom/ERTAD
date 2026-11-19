import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { decode as decodeCbor } from 'cbor-x';

export interface VerifiedRegistration {
  credentialId: string;
  publicKeySpki: string;
  algorithm: -7 | -257;
  signCount: number;
}

export interface VerifiedAssertion {
  signCount: number;
}

function sha256(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest();
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function rpIdFromOrigin(origin: string): string {
  return new URL(origin).hostname;
}

function parseClientData(
  clientDataB64: string,
  expectedType: 'webauthn.create' | 'webauthn.get',
  expectedChallenge: string,
  expectedOrigins: string[]
): Buffer {
  const clientDataBuf = decodeBase64Url(clientDataB64);
  let parsed: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    parsed = JSON.parse(clientDataBuf.toString('utf8'));
  } catch {
    throw new Error('INVALID_CLIENT_DATA');
  }
  if (parsed.type !== expectedType) {
    throw new Error('INVALID_WEBAUTHN_TYPE');
  }
  if (typeof parsed.challenge !== 'string' || parsed.challenge !== expectedChallenge) {
    throw new Error('CHALLENGE_MISMATCH');
  }
  if (typeof parsed.origin !== 'string' || !expectedOrigins.includes(parsed.origin)) {
    throw new Error('ORIGIN_MISMATCH');
  }
  return clientDataBuf;
}

function coseKeyToSpki(coseRaw: unknown): { spki: string; algorithm: -7 | -257 } {
  if (!coseRaw || typeof coseRaw !== 'object') {
    throw new Error('INVALID_COSE_KEY');
  }
  const get = (k: number): unknown =>
    coseRaw instanceof Map ? coseRaw.get(k) : (coseRaw as Record<string, unknown>)[String(k)];

  const kty = get(1);
  const alg = get(3);
  if (kty === 2 && alg === -7) {
    const crv = get(-1);
    const x = get(-2);
    const y = get(-3);
    if (crv !== 1 || !Buffer.isBuffer(x) && !(x instanceof Uint8Array) || !Buffer.isBuffer(y) && !(y instanceof Uint8Array)) {
      throw new Error('UNSUPPORTED_EC2_KEY');
    }
    const xb = Buffer.from(x);
    const yb = Buffer.from(y);
    if (xb.length !== 32 || yb.length !== 32) {
      throw new Error('INVALID_P256_POINT');
    }
    const keyObj = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: xb.toString('base64url'),
        y: yb.toString('base64url'),
      },
      format: 'jwk',
    });
    return {
      spki: keyObj.export({ type: 'spki', format: 'pem' }).toString(),
      algorithm: -7,
    };
  }

  if (kty === 3 && alg === -257) {
    const n = get(-1);
    const e = get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
      throw new Error('UNSUPPORTED_RSA_KEY');
    }
    const keyObj = createPublicKey({
      key: {
        kty: 'RSA',
        n: Buffer.from(n).toString('base64url'),
        e: Buffer.from(e).toString('base64url'),
      },
      format: 'jwk',
    });
    return {
      spki: keyObj.export({ type: 'spki', format: 'pem' }).toString(),
      algorithm: -257,
    };
  }

  throw new Error('UNSUPPORTED_CREDENTIAL_ALGORITHM');
}

export function verifyRegistrationAttestation(params: {
  clientDataJSON: string;
  attestationObject: string;
  expectedChallenge: string;
  expectedOrigins: string[];
  rpId: string;
}): VerifiedRegistration {
  parseClientData(
    params.clientDataJSON,
    'webauthn.create',
    params.expectedChallenge,
    params.expectedOrigins
  );
  const attBuf = decodeBase64Url(params.attestationObject);
  const att = decodeCbor(attBuf) as { authData?: Uint8Array };
  if (!att || !(att.authData instanceof Uint8Array)) {
    throw new Error('INVALID_ATTESTATION_OBJECT');
  }
  const authData = Buffer.from(att.authData);
  if (authData.length < 55) {
    throw new Error('TRUNCATED_AUTH_DATA');
  }
  const expectedRpHash = sha256(params.rpId);
  if (!authData.subarray(0, 32).equals(expectedRpHash)) {
    throw new Error('RP_ID_MISMATCH');
  }
  const flags = authData[32];
  const userPresent = (flags & 0x01) !== 0;
  const attestedCredentialData = (flags & 0x40) !== 0;
  if (!userPresent || !attestedCredentialData) {
    throw new Error('MISSING_USER_PRESENCE_OR_ATTESTATION');
  }
  const signCount = authData.readUInt32BE(33);
  const credIdLen = authData.readUInt16BE(53);
  const credIdEnd = 55 + credIdLen;
  if (credIdLen < 16 || credIdEnd >= authData.length) {
    throw new Error('INVALID_CREDENTIAL_ID');
  }
  const credentialId = authData.subarray(55, credIdEnd).toString('base64url');
  const coseKey = decodeCbor(authData.subarray(credIdEnd));
  const { spki, algorithm } = coseKeyToSpki(coseKey);
  return { credentialId, publicKeySpki: spki, algorithm, signCount };
}

export function verifyAssertionSignature(params: {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  expectedChallenge: string;
  expectedOrigins: string[];
  rpId: string;
  publicKeySpki: string;
  algorithm: number;
  previousSignCount: number;
}): VerifiedAssertion {
  const clientDataBuf = parseClientData(
    params.clientDataJSON,
    'webauthn.get',
    params.expectedChallenge,
    params.expectedOrigins
  );
  const authData = decodeBase64Url(params.authenticatorData);
  if (authData.length < 37) {
    throw new Error('TRUNCATED_AUTH_DATA');
  }
  if (!authData.subarray(0, 32).equals(sha256(params.rpId))) {
    throw new Error('RP_ID_MISMATCH');
  }
  const flags = authData[32];
  if ((flags & 0x01) === 0) {
    throw new Error('MISSING_USER_PRESENCE');
  }
  const signCount = authData.readUInt32BE(33);
  if (params.previousSignCount > 0 && signCount <= params.previousSignCount) {
    throw new Error('REPLAYED_SIGN_COUNT');
  }
  const sigBuf = decodeBase64Url(params.signature);
  const signedPayload = Buffer.concat([authData, sha256(clientDataBuf)]);
  if (params.algorithm !== -7 && params.algorithm !== -257) {
    throw new Error('UNSUPPORTED_ALGORITHM');
  }
  const ok = createVerify('SHA256')
    .update(signedPayload)
    .verify(params.publicKeySpki, sigBuf);
  if (!ok) {
    throw new Error('INVALID_ASSERTION_SIGNATURE');
  }
  return { signCount };
}

