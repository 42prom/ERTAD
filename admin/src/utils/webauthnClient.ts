export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials
  );
}

function fromBase64Url(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export interface ServerRegistrationOptions {
  challengeId: string;
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout: number;
  attestation: AttestationConveyancePreference;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  excludeCredentials: { type: "public-key"; id: string }[];
}

export interface ServerAssertionOptions {
  challengeId: string;
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: UserVerificationRequirement;
  allowCredentials?: { type: "public-key"; id: string }[];
}

export async function startPasskeyRegistration(
  options: ServerRegistrationOptions,
): Promise<{
  clientDataJSON: string;
  attestationObject: string;
  transports: string[];
}> {
  if (!isWebAuthnSupported()) {
    throw new Error("WEBAUTHN_UNSUPPORTED");
  }
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64Url(options.challenge),
      rp: options.rp,
      user: {
        id: fromBase64Url(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: options.excludeCredentials.map((c) => ({
        type: c.type,
        id: fromBase64Url(c.id),
      })),
    },
  })) as PublicKeyCredential | null;

  if (!cred) throw new Error("WEBAUTHN_CANCELLED");
  const resp = cred.response as AuthenticatorAttestationResponse;
  const transports =
    typeof resp.getTransports === "function" ? resp.getTransports() : [];
  return {
    clientDataJSON: toBase64Url(resp.clientDataJSON),
    attestationObject: toBase64Url(resp.attestationObject),
    transports,
  };
}

export async function startPasskeyAssertion(
  options: ServerAssertionOptions,
): Promise<{
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}> {
  if (!isWebAuthnSupported()) {
    throw new Error("WEBAUTHN_UNSUPPORTED");
  }
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
      allowCredentials: options.allowCredentials?.map((c) => ({
        type: c.type,
        id: fromBase64Url(c.id),
      })),
    },
  })) as PublicKeyCredential | null;

  if (!cred) throw new Error("WEBAUTHN_CANCELLED");
  const resp = cred.response as AuthenticatorAssertionResponse;
  return {
    credentialId: toBase64Url(cred.rawId),
    clientDataJSON: toBase64Url(resp.clientDataJSON),
    authenticatorData: toBase64Url(resp.authenticatorData),
    signature: toBase64Url(resp.signature),
  };
}

