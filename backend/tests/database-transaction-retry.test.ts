const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
const mockOn = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: mockConnect,
    on: mockOn,
    end: jest.fn(),
  })),
}));
import { retryDeadlockedTransaction } from '../src/db/client';

describe('bounded retries for database-only deadlocks', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [] });
    mockRelease.mockReset();
    mockConnect.mockReset().mockResolvedValue({ query: mockQuery, release: mockRelease });
    log = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());
  it('rolls back before rerunning the entire authorization/write/audit callback', async () => {
    const callback = jest
      .fn()
      .mockRejectedValueOnce({ code: '40P01' })
      .mockResolvedValueOnce('saved');
    await expect(retryDeadlockedTransaction(callback)).resolves.toBe('saved');
    expect(mockQuery.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      'ROLLBACK',
      'BEGIN',
      'COMMIT',
    ]);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });
  it.each(['42501', 'P0409', '08006'])(
    'does not retry authority, conflict or uncertain connection errors: %s',
    async (code) => {
      const error = { code },
        callback = jest.fn().mockRejectedValue(error);
      await expect(retryDeadlockedTransaction(callback)).rejects.toBe(error);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    }
  );
  it('stops after three aborted attempts', async () => {
    const error = { code: '40P01' },
      callback = jest.fn().mockRejectedValue(error);
    await expect(retryDeadlockedTransaction(callback)).rejects.toBe(error);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(mockRelease).toHaveBeenCalledTimes(3);
  });
  it('does not log a pool client or connection credentials on idle errors', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const handler = mockOn.mock.calls.find((call) => call[0] === 'error')![1];
      handler({
        message: 'Synthetic pool error',
        code: '57P01',
        client: { password: 'synthetic-secret-canary' },
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-secret-canary');
      expect(log).toHaveBeenCalledWith(
        'Unexpected error on idle client',
        expect.objectContaining({ code: '57P01' })
      );
    } finally {
      exit.mockRestore();
    }
  });
});
