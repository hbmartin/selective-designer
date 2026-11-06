import { Result } from '@bloodyowl/boxed';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/modules/kernel';

const state = vi.hoisted(() => ({
  deliver: vi.fn(),
  list: vi.fn(),
  summary: vi.fn(),
  startedAt: vi.fn(),
}));
vi.mock('@/composition/accounting-pipeline', () => ({
  getAccountingRecovery: () => state,
}));
import {
  accountingDeliveryWorkflow,
  accountingReconcileWorkflow,
} from '@/modules/kernel/workflows/backend';

describe('accounting recovery workflows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.startedAt.mockReturnValue('2026-11-06T07:00:00.000Z');
    state.summary.mockResolvedValue(
      Result.Ok({ type: 'accounting_summary', pending: 1, oldest: null })
    );
  });
  it('redrives a receipt without any model provider path', async () => {
    state.deliver.mockResolvedValue(Result.Ok({ type: 'receipt_delivered' }));
    expect(
      await accountingDeliveryWorkflow({ receiptId: 'receipt-one' })
    ).toEqual({ type: 'receipt_delivered' });
    expect(state.deliver).toHaveBeenCalledWith('receipt-one');
  });
  it('advances the snapshot cursor past exhausted receipts', async () => {
    state.list
      .mockResolvedValueOnce(
        Result.Ok({ type: 'pending_receipts', ids: ['a', 'b'] })
      )
      .mockResolvedValueOnce(
        Result.Ok({ type: 'pending_receipts', ids: ['c'] })
      )
      .mockResolvedValueOnce(Result.Ok({ type: 'pending_receipts', ids: [] }));
    state.deliver.mockImplementation(async (id: string) =>
      id === 'a'
        ? Result.Error(
            new AppError({ code: 'LOG_DOWN', category: 'system', status: 500 })
          )
        : Result.Ok({ type: 'receipt_delivered' })
    );
    const outcome = await accountingReconcileWorkflow();
    expect(state.deliver.mock.calls).toEqual([['a'], ['b'], ['c']]);
    expect(outcome).toEqual({
      delivered: 2,
      failed: 1,
      pending: 1,
    });
    expect(state.list).toHaveBeenNthCalledWith(2, {
      before: '2026-11-06T07:00:00.000Z',
      after: 'b',
    });
    expect(state.list).toHaveBeenNthCalledWith(3, {
      before: '2026-11-06T07:00:00.000Z',
      after: 'c',
    });
    expect(state.deliver).toHaveBeenCalledTimes(3);
  });
  it('caps delivery concurrency at five while paging past a full batch and isolating failures', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `receipt-${i}`);
    state.list
      .mockResolvedValueOnce(Result.Ok({ type: 'pending_receipts', ids }))
      .mockResolvedValueOnce(
        Result.Ok({ type: 'pending_receipts', ids: ['last-receipt'] })
      )
      .mockResolvedValueOnce(Result.Ok({ type: 'pending_receipts', ids: [] }));
    let active = 0;
    let maximum = 0;
    state.deliver.mockImplementation(async (id: string) => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return id === 'receipt-2'
        ? Result.Error(
            new AppError({ code: 'SINK_DOWN', category: 'system', status: 500 })
          )
        : Result.Ok({ type: 'receipt_delivered' });
    });
    expect(await accountingReconcileWorkflow()).toEqual({
      delivered: 100,
      failed: 1,
      pending: 1,
    });
    expect(maximum).toBe(5);
    expect(state.list).toHaveBeenNthCalledWith(2, {
      before: '2026-11-06T07:00:00.000Z',
      after: ids.at(-1),
    });
  });
});
