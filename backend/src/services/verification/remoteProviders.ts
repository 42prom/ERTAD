import { IFaceMatchProvider, ILivenessProvider, VerificationResult } from './types';

// Retained adapter boundaries. No vendor implementation is accepted in the ERTAD runtime yet.
// A configured key must never turn a placeholder into identity assurance.
export class RemoteLivenessProvider implements ILivenessProvider {
  constructor(_providerName: string) {}
  async verify(_selfie: Buffer, _apiKey?: string): Promise<VerificationResult> {
    return { success: false, error: 'VERIFICATION_PROVIDER_NOT_IMPLEMENTED', isRetryable: false };
  }
}
export class RemoteFaceMatchProvider implements IFaceMatchProvider {
  constructor(_providerName: string) {}
  async match(_selfie: Buffer, _docPortrait: Buffer, _apiKey?: string): Promise<VerificationResult> {
    return { success: false, error: 'VERIFICATION_PROVIDER_NOT_IMPLEMENTED', isRetryable: false };
  }
}
