import { okValue } from '@tests/support/result';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toProviderCallId } from '@/modules/kernel';
import {
  ACCOUNTING_DISPATCH_TIMEOUT_MS,
  dispatchProviderReceipt,
} from '@/modules/kernel/infrastructure/db/provider-accounting-dispatch';

describe('bounded accounting dispatch', () => {
  afterEach(() => vi.useRealTimers());
  it('ends a stalled dispatch without waiting for its late queue reply', async () => {
    vi.useFakeTimers();
    const pending = dispatchProviderReceipt(
      () => new Promise(() => {}),
      okValue(toProviderCallId('receipt'))
    );
    const elapsed = vi.advanceTimersByTimeAsync(ACCOUNTING_DISPATCH_TIMEOUT_MS);
    await expect(pending).rejects.toMatchObject({
      code: 'ACCOUNTING_DISPATCH_TIMEOUT',
    });
    await elapsed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases the deadline when queue publication succeeds', async () => {
    vi.useFakeTimers();
    await dispatchProviderReceipt(
      async () => {},
      okValue(toProviderCallId('receipt'))
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves an immediate queue error', async () => {
    vi.useFakeTimers();
    const original = new Error('queue unavailable');
    await expect(
      dispatchProviderReceipt(
        async () => {
          throw original;
        },
        okValue(toProviderCallId('receipt'))
      )
    ).rejects.toBe(original);
    expect(vi.getTimerCount()).toBe(0);
  });
});
