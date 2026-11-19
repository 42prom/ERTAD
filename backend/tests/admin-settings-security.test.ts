import {
  isMaskedSecret,
  validateAdminSettingsPatch,
  validateFirebaseServiceAccount,
} from '../src/services/adminSettingsValidation';
import { assertSafeOutboundHttpsUrl } from '../src/services/outboundUrl';

describe('admin settings security validation', () => {
  test.each(['maxDistinctVotersPerDevicePerPoll', 'requireDeviceAttestationForVote'])(
    'rejects removed voting security setting %s', async field => {
      await expect(validateAdminSettingsPatch({ security: { [field]: true } }))
        .rejects.toMatchObject({ statusCode: 400 });
    },
  );
  test.each([
    'rewards_enabled_global', 'nft_payouts_enabled_global', 'chain_id', 'rpc_url',
    'nft_contract_address', 'ertad_token_address', 'reward_token_id', 'required_confirmations',
  ])('rejects removed currency setting %s before persistence or network access', async field => {
    await expect(validateAdminSettingsPatch({ [field]: 'retired-setting' }))
      .rejects.toMatchObject({ statusCode: 400, message: `settings.${field} is not supported` });
  });

  test('rejects server filesystem credential paths', async () => {
    await expect(
      validateAdminSettingsPatch({ push: { serviceAccountPath: 'C:\\secrets\\firebase.json' } })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects obsolete voting rate limits and per-poll identity counters', async () => {
    await expect(validateAdminSettingsPatch({ rate_limit_vote: { poll: 1, account: 3, window: 1 } }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(validateAdminSettingsPatch({ rate_limit_login: { poll: 1, window: 1 } }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('validates the expected Firebase service account fields', () => {
    expect(() => validateFirebaseServiceAccount(JSON.stringify({ type: 'service_account' })))
      .toThrow('missing project_id');

    expect(() => validateFirebaseServiceAccount(JSON.stringify({
      type: 'service_account',
      project_id: 'project',
      private_key: 'private-key',
      client_email: 'firebase@example.test',
    }))).not.toThrow();
  });

  test('recognizes masked values and rejects unknown policy fields', async () => {
    expect(isMaskedSecret(`abcd${'\u2022'.repeat(8)}wxyz`)).toBe(true);
    await expect(validateAdminSettingsPatch({ unexpected: true }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects private, metadata and non-HTTPS service destinations', async () => {
    await expect(assertSafeOutboundHttpsUrl('https://127.0.0.1', 'AUDIT_CHECKPOINT_ALLOWED_HOSTS', 'Checkpoint URL')).rejects.toThrow('private');
    await expect(assertSafeOutboundHttpsUrl('https://169.254.169.254/latest/meta-data', 'AUDIT_CHECKPOINT_ALLOWED_HOSTS', 'Checkpoint URL'))
      .rejects.toThrow('private');
    await expect(assertSafeOutboundHttpsUrl('http://8.8.8.8', 'AUDIT_CHECKPOINT_ALLOWED_HOSTS', 'Checkpoint URL')).rejects.toThrow('HTTPS');
  });

  test('accepts a syntactically safe public HTTPS IP endpoint outside production', async () => {
    await expect(assertSafeOutboundHttpsUrl('https://8.8.8.8/checkpoint', 'AUDIT_CHECKPOINT_ALLOWED_HOSTS', 'Checkpoint URL'))
      .resolves.toBe('https://8.8.8.8/checkpoint');
  });

  test('rejects invalid bounds before persistence', async () => {
    await expect(validateAdminSettingsPatch({
      security: { maxBiometricAttemptsPerIP: 0 },
    })).rejects.toMatchObject({ statusCode: 400 });

    await expect(validateAdminSettingsPatch({
      rate_limit_login: { account: 3, window: 0 },
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});

