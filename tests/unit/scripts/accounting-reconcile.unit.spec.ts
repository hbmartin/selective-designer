import { Result } from '@bloodyowl/boxed';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/modules/kernel';

const state = vi.hoisted(() => ({
  db: { $close: vi.fn() },
  client: vi.fn(),
  deliver: vi.fn(),
  list: vi.fn(),
  summary: vi.fn(),
}));
vi.mock('@/modules/kernel/backend', () => ({
  getDefaultDbClient: state.client,
  createProviderAccounting: () => ({ deliver: state.deliver }),
  pendingProviderReceipts: state.list,
  providerAccountingSummary: state.summary,
}));
const exitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCode;
});
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  state.client.mockReturnValue(state.db);
  state.db.$close.mockResolvedValue(undefined);
  state.list.mockResolvedValue(
    Result.Ok({ type: 'pending_receipts', ids: [] })
  );
  state.summary.mockResolvedValue(
    Result.Ok({ type: 'accounting_summary', pending: 0, oldest: null })
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
const run = () => import('../../../scripts/accounting-reconcile');
describe('accounting operator command', () => {
  it('reports safe diagnostics when client acquisition fails', async () => {
    state.client.mockImplementation(() => {
      throw Object.assign(new Error('postgres://private-secret@host'), {
        code: 'ECONNREFUSED',
      });
    });
    await run();
    expect(console.error).toHaveBeenCalledWith(
      'Accounting reconciliation failed.',
      expect.objectContaining({ code: 'ECONNREFUSED' })
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'private-secret'
    );
    expect(state.db.$close).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it('retains the original failure and reports close failure safely', async () => {
    state.summary.mockResolvedValue(
      Result.Error(
        new AppError({
          code: 'SUMMARY_FAILED',
          category: 'system',
          status: 500,
        })
      )
    );
    state.db.$close.mockRejectedValue(
      Object.assign(new Error('private credential'), { code: 'EPIPE' })
    );
    await run();
    expect(console.error).toHaveBeenNthCalledWith(
      1,
      'Accounting reconciliation failed.',
      expect.objectContaining({ code: 'SUMMARY_FAILED' })
    );
    expect(console.error).toHaveBeenNthCalledWith(
      2,
      'Closing the accounting database connection failed.',
      expect.objectContaining({ code: 'EPIPE' })
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'private credential'
    );
    expect(state.db.$close).toHaveBeenCalledOnce();
  });
});
