import { SecurityTelemetry } from '../src/modules/security/telemetry';

test('classifies completed denials without treating successful requests as incidents', () => {
  const monitor = new SecurityTelemetry(() => 1_800_000);
  for (const code of [200, 204, 301, 400, 404]) monitor.observe(code, 'login_failed');
  monitor.observe(401, 'login_failed');
  monitor.observe(401, 'step_up_failed');
  monitor.observe(401, 'untrusted-label');
  monitor.observe(403);
  monitor.observe(429);
  monitor.observe(503);
  expect(monitor.snapshot(15, 'all').totals).toEqual({
    login_failed: 1,
    step_up_failed: 1,
    authentication_required: 1,
    access_denied: 1,
    rate_limited: 1,
    server_error: 1,
  });
  expect(JSON.stringify(monitor.snapshot(15, 'all'))).not.toContain('untrusted-label');
});
test('bounded retention discards old buckets and reports partial observation after restart', () => {
  let now = 60_000;
  const monitor = new SecurityTelemetry(() => now);
  for (let i = 0; i < 150; i++) {
    monitor.observe(403);
    now += 60_000;
  }
  const result = monitor.snapshot(60, 'all');
  expect(result.items).toHaveLength(59);
  expect(result.totals.access_denied).toBe(59);
  expect(monitor.snapshot(15, 'all').totals.access_denied).toBe(14);
  now += 60 * 60_000;
  expect(monitor.snapshot(60, 'all').items).toEqual([]);
  const restarted = new SecurityTelemetry(() => now);
  expect(restarted.snapshot(60, 'all').observedSince).toBe(new Date(now).toISOString());
  expect(restarted.snapshot(60, 'all').items).toEqual([]);
});
test('filtered snapshots cannot mutate stored counters and have no identity fields', () => {
  const monitor = new SecurityTelemetry(() => 1_800_000);
  monitor.observe(401, 'login_failed');
  monitor.observe(403);
  const view = monitor.snapshot(15, 'access_denied');
  expect(view.totals.login_failed).toBe(0);
  view.items[0].counts.access_denied = 99;
  expect(monitor.snapshot(15, 'all').totals.access_denied).toBe(1);
  expect(Object.keys(view.items[0]).sort()).toEqual(['at', 'counts']);
});
