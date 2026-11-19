import type { DependencyChecks } from '../../app';

export const diagnosticTargets = ['postgres', 'redis', 'storage'] as const;
export type DiagnosticTarget = (typeof diagnosticTargets)[number];
export function integrationInventory(checks?: Partial<DependencyChecks>) {
  return [
    ...diagnosticTargets.map((id) => ({
      id,
      category: 'infrastructure',
      active: !!checks?.[id],
      configuration: checks?.[id] ? 'loaded' : 'missing',
      diagnostic: checks?.[id] ? 'available' : 'unavailable',
      assurance: 'not_applicable',
      blocker: checks?.[id] ? null : 'runtime_binding_missing',
    })),
    ...[
      ['document', 'identity', 'mobile_contract_pending'],
      ['liveness', 'identity', 'pad_not_implemented'],
      ['face_match', 'identity', 'provider_acceptance_pending'],
      ['android_integrity', 'device', 'mobile_contract_pending'],
      ['apple_attest', 'device', 'mobile_contract_pending'],
      ['push', 'delivery', 'member_delivery_pending'],
      ['shield', 'security', 'response_policy_pending'],
      ['audit_checkpoint', 'security', 'external_checkpoint_pending'],
    ].map(([id, category, blocker]) => ({
      id,
      category,
      active: false,
      configuration: 'not_loaded',
      diagnostic: 'unavailable',
      assurance: 'not_verified',
      blocker,
    })),
  ];
}

/** Fixed runtime bindings only: no browser URLs, credentials, redirects or identity media. */
export async function diagnoseIntegration(
  target: DiagnosticTarget,
  checks?: Partial<DependencyChecks>
) {
  const check = checks?.[target];
  const started = Date.now();
  let status: 'ready' | 'unavailable' | 'not_configured' = check ? 'unavailable' : 'not_configured';
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (check)
    try {
      await Promise.race([
        Promise.resolve().then(check),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 2000);
        }),
      ]);
      status = 'ready';
    } catch {
      status = 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  return { target, status, checkedAt: new Date().toISOString(), durationMs: Date.now() - started };
}
