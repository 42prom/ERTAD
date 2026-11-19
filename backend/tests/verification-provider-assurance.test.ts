import { VerificationProviderFactory } from '../src/services/verification/providerFactory';
import {
  RemoteFaceMatchProvider,
  RemoteLivenessProvider,
} from '../src/services/verification/remoteProviders';
import { InHouseLivenessProvider } from '../src/services/verification/inHouseProviders';
import { HttpClientFactory } from '../src/utils/httpClient';
import { diagnoseIntegration, integrationInventory } from '../src/modules/security/integrations';
jest.mock('../src/utils/httpClient', () => ({
  HttpClientFactory: { getBiometricClient: jest.fn() },
}));
jest.mock('../src/services/settingsService', () => ({
  SettingsService: { getSetting: jest.fn() },
}));

describe('verification provider assurance boundaries', () => {
  const synthetic = Buffer.from('synthetic non-image fixture');
  test.each([undefined, 'synthetic-api-key'])(
    'unimplemented remote adapters deny assurance with key %s',
    async (key) => {
      const live = await new RemoteLivenessProvider('facetec').verify(synthetic, key);
      const match = await new RemoteFaceMatchProvider('aws-rekognition').match(
        synthetic,
        synthetic,
        key
      );
      for (const result of [live, match]) {
        expect(result).toEqual({
          success: false,
          error: 'VERIFICATION_PROVIDER_NOT_IMPLEMENTED',
          isRetryable: false,
        });
        expect(result.score).toBeUndefined();
      }
    }
  );
  test('face presence cannot produce a liveness pass or transmit identity media', async () => {
    expect(await new InHouseLivenessProvider().verify(synthetic)).toMatchObject({
      success: false,
      error: 'LIVENESS_ASSURANCE_NOT_IMPLEMENTED',
    });
    expect(HttpClientFactory.getBiometricClient).not.toHaveBeenCalled();
  });
  test.each(['unknown', 'mock', 'manual', 'provider'])(
    'unsupported selection %s cannot silently choose a weaker fallback',
    (provider) => {
      expect(() => VerificationProviderFactory.getLivenessProvider(provider)).toThrow(
        'Unsupported'
      );
      expect(() => VerificationProviderFactory.getFaceMatchProvider(provider)).toThrow(
        'Unsupported'
      );
    }
  );
  test('runtime inventory distinguishes missing connections from inactive identity providers without probing', () => {
    const postgres = jest.fn();
    const items = integrationInventory({ postgres });
    expect(items.find((i) => i.id === 'postgres')).toMatchObject({
      active: true,
      configuration: 'loaded',
    });
    expect(items.find((i) => i.id === 'redis')).toMatchObject({
      active: false,
      configuration: 'missing',
    });
    expect(items.find((i) => i.id === 'liveness')).toMatchObject({
      active: false,
      assurance: 'not_verified',
      blocker: 'pad_not_implemented',
    });
    expect(postgres).not.toHaveBeenCalled();
  });
  test('probe failures disclose neither exception contents nor credentials', async () => {
    const result = await diagnoseIntegration('storage', {
      storage: async () => {
        throw Error('secret-url-and-key');
      },
    });
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('secret-url');
    expect((await diagnoseIntegration('redis')).status).toBe('not_configured');
  });
  test('unresponsive probe has a bounded deadline', async () => {
    jest.useFakeTimers();
    try {
      const result = diagnoseIntegration('postgres', { postgres: () => new Promise(() => {}) });
      await jest.advanceTimersByTimeAsync(2001);
      expect((await result).status).toBe('unavailable');
    } finally {
      jest.useRealTimers();
    }
  });
});
