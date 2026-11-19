import { Counter, Registry } from 'prom-client';

// Fixed-cardinality, process-local & persisted 72h observations. Never retain request/identity data.
export const securitySignals = [
  'login_failed',
  'step_up_failed',
  'authentication_required',
  'access_denied',
  'rate_limited',
  'server_error',
] as const;
export type SecuritySignal = (typeof securitySignals)[number];
type Counts = Record<SecuritySignal, number>;
const empty = (): Counts => Object.fromEntries(securitySignals.map((k) => [k, 0])) as Counts;
const minute = 60_000;

export class SecurityTelemetry {
  private readonly startedAt: number;
  private readonly buckets = new Map<number, Counts>();
  private readonly pendingFlush = new Map<number, Counts>();
  private readonly registry = new Registry();
  private readonly signalCounter: Counter<'signal'>;
  private readonly responseCounter: Counter<'status_class'>;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
    this.signalCounter = new Counter({
      name: 'ertad_security_signals_total',
      help: 'Total observed HTTP security signals (zero PII)',
      labelNames: ['signal'],
      registers: [this.registry],
    });
    this.responseCounter = new Counter({
      name: 'ertad_http_responses_total',
      help: 'Total observed /api/v1 responses by HTTP status class',
      labelNames: ['status_class'],
      registers: [this.registry],
    });
  }

  get metricsContentType(): string {
    return this.registry.contentType;
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  private prune(now: number) {
    const first = Math.floor(now / minute) - 59;
    for (const key of this.buckets.keys())
      if (key < first || key > Math.floor(now / minute)) this.buckets.delete(key);
  }

  observe(status: number, signal?: unknown) {
    if (status >= 200 && status <= 599) {
      const cls = `${Math.floor(status / 100)}xx`;
      this.responseCounter.inc({ status_class: cls });
    }
    const kind: SecuritySignal | undefined =
      status === 401 && signal === 'login_failed'
        ? 'login_failed'
        : status === 401 && signal === 'step_up_failed'
          ? 'step_up_failed'
          : status === 401
            ? 'authentication_required'
            : status === 403
              ? 'access_denied'
              : status === 429
                ? 'rate_limited'
                : status >= 500 && status <= 599
                  ? 'server_error'
                  : undefined;
    if (!kind) return;
    this.signalCounter.inc({ signal: kind });
    const now = this.now();
    this.prune(now);
    const key = Math.floor(now / minute);
    const counts = this.buckets.get(key) ?? empty();
    counts[kind] = Math.min(Number.MAX_SAFE_INTEGER, counts[kind] + 1);
    this.buckets.set(key, counts);

    const delta = this.pendingFlush.get(key) ?? empty();
    delta[kind] = Math.min(Number.MAX_SAFE_INTEGER, delta[kind] + 1);
    this.pendingFlush.set(key, delta);
  }

  async flush(queryFn: (text: string, params?: unknown[]) => Promise<unknown>): Promise<void> {
    if (!this.pendingFlush.size) return;
    const entries = [...this.pendingFlush.entries()];
    this.pendingFlush.clear();
    for (const [key, delta] of entries) {
      try {
        await queryFn('SELECT ertad.record_security_telemetry($1, $2)', [
          new Date(key * minute).toISOString(),
          JSON.stringify(delta),
        ]);
      } catch {
        const current = this.pendingFlush.get(key) ?? empty();
        for (const sig of securitySignals) {
          current[sig] = Math.min(Number.MAX_SAFE_INTEGER, current[sig] + delta[sig]);
        }
        this.pendingFlush.set(key, current);
      }
    }
  }

  snapshot(minutes: 15 | 60, category: SecuritySignal | 'all') {
    const now = this.now();
    this.prune(now);
    const first = Math.floor(now / minute) - minutes + 1;
    const totals = empty();
    const items = [...this.buckets]
      .filter(([key]) => key >= first)
      .sort(([a], [b]) => b - a)
      .map(([key, counts]) => {
        const filtered = empty();
        for (const kind of securitySignals) {
          if (category === 'all' || category === kind) {
            filtered[kind] = counts[kind];
            totals[kind] = Math.min(Number.MAX_SAFE_INTEGER, totals[kind] + counts[kind]);
          }
        }
        return { at: new Date(key * minute).toISOString(), counts: filtered };
      })
      .filter((item) => Object.values(item.counts).some(Boolean));
    return {
      checkedAt: new Date(now).toISOString(),
      observedSince: new Date(Math.max(this.startedAt, first * minute)).toISOString(),
      processStartedAt: new Date(this.startedAt).toISOString(),
      minutes,
      category,
      retention: 'process_memory_60_minutes' as const,
      totals,
      items,
    };
  }

  async persistedSnapshot(
    queryFn: (text: string, params?: unknown[]) => Promise<{ rows: { r: { items?: { at: string; counts: Record<string, number> }[] } }[] }>,
    sid: string,
    tokenHash: string,
    minutes: 15 | 60 | 1440,
    category: SecuritySignal | 'all'
  ) {
    await this.flush(queryFn);
    const now = this.now();
    const first = Math.floor(now / minute) - minutes + 1;
    const row = (
      await queryFn('SELECT ertad.read_security_telemetry($1,$2,$3,$4) AS r', [
        sid,
        tokenHash,
        minutes,
        category,
      ])
    ).rows[0]?.r;
    const totals = empty();
    const rawItems = Array.isArray(row?.items) ? row.items : [];
    const items = rawItems
      .map((item) => {
        const filtered = empty();
        for (const kind of securitySignals) {
          if (category === 'all' || category === kind) {
            const val = Number(item.counts?.[kind] ?? 0);
            filtered[kind] = val;
            totals[kind] = Math.min(Number.MAX_SAFE_INTEGER, totals[kind] + val);
          }
        }
        return { at: new Date(item.at).toISOString(), counts: filtered };
      })
      .filter((item) => Object.values(item.counts).some(Boolean));
    return {
      checkedAt: new Date(now).toISOString(),
      observedSince: new Date(first * minute).toISOString(),
      processStartedAt: new Date(this.startedAt).toISOString(),
      minutes,
      category,
      retention: 'persisted_database_72_hours' as const,
      totals,
      items,
    };
  }
}
