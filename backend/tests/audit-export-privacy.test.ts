import { AuditExportOptions, AuditExportService, PollMetadata } from '../src/services/auditExport';

function options(overrides: Partial<AuditExportOptions> = {}): AuditExportOptions {
  return {
    pollId: 'poll-1',
    includeVoteLevelData: false,
    anonymizeVoters: true,
    adminUserId: 'auditor-1',
    adminEmail: 'auditor@example.ge',
    ...overrides,
  };
}

const poll = {
  id: 'poll-1',
  title: 'Test',
  description: null,
  type: 'election',
  status: 'ended',
  start_at: new Date(),
  end_at: new Date(),
  created_at: new Date(),
  published_at: new Date(),
  min_k_anonymity: 30,
  audience_rules: {},
} as PollMetadata;

describe('audit export ballot-secrecy invariants', () => {
  afterEach(() => jest.restoreAllMocks());
  const service = new AuditExportService() as unknown as {
    assertPrivacySafeExport(
      exportOptions: AuditExportOptions,
      pollMetadata: PollMetadata,
      totalVotes: number
    ): void;
  };

  it('rejects vote-level records even when voter IDs would be renamed', () => {
    expect(() =>
      service.assertPrivacySafeExport(options({ includeVoteLevelData: true }), poll, 100)
    ).toThrow(/ballot secrecy/);
  });

  it('rejects non-anonymized export settings', () => {
    expect(() =>
      service.assertPrivacySafeExport(options({ anonymizeVoters: false }), poll, 100)
    ).toThrow(/non-anonymized/);
  });

  it('suppresses exports below the strongest configured k threshold', () => {
    process.env.MIN_K_ANONYMITY = '40';
    expect(() => service.assertPrivacySafeExport(options(), poll, 39)).toThrow(
      /privacy threshold of 40/
    );
    expect(() => service.assertPrivacySafeExport(options(), poll, 40)).not.toThrow();
  });

  function aggregateExport() {
    const exporter = new AuditExportService();
    jest.spyOn(exporter, 'validatePoll').mockResolvedValue(poll);
    jest.spyOn(exporter, 'getOptions').mockResolvedValue([
      { id: 'a', text: 'Option A', display_order: 0 },
      { id: 'b', text: 'Option B', display_order: 1 },
    ]);
    jest.spyOn(exporter, 'getAggregatedResults').mockResolvedValue([
      { option_id: 'a', option_text: 'Option A', vote_count: '20' },
      { option_id: 'b', option_text: 'Option B', vote_count: '20' },
    ]);
    jest.spyOn(exporter, 'getTotalVotes').mockResolvedValue(40);
    jest.spyOn(exporter, 'getParticipantCount').mockResolvedValue(40);
    jest.spyOn(exporter, 'logExport').mockResolvedValue();
    return exporter;
  }

  it('retains aggregate CSV and ends its stream without individual records or proofs', async () => {
    const exporter = aggregateExport();
    const result = await exporter.generateExport(options());
    const stream = await exporter.createExportStream(options());
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk.toString());
    for (const csv of [result.csvContent, chunks.join('')]) {
      expect(csv).toContain('Option A,20,50.00%');
      expect(csv).toContain('Option B,20,50.00%');
      expect(csv).not.toMatch(/Merkle|Vote Hash|INDIVIDUAL VOTE|CRYPTOGRAPHIC PROOF/);
    }
    expect(exporter.logExport).toHaveBeenCalledTimes(2);
  });

  it('rejects individual records and audit failures before creating any output stream', async () => {
    const exporter = aggregateExport();
    await expect(exporter.createExportStream(options({ includeVoteLevelData: true })))
      .rejects.toThrow(/ballot secrecy/);
    expect(exporter.logExport).not.toHaveBeenCalled();
    jest.mocked(exporter.logExport).mockRejectedValue(new Error('Synthetic audit outage'));
    await expect(exporter.createExportStream(options())).rejects.toThrow('Synthetic audit outage');
    await expect(exporter.generateExport(options())).rejects.toThrow('Synthetic audit outage');
  });
});
