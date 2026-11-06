import { Result } from '@bloodyowl/boxed';
import { createFakeProviderCallLog } from '@tests/support/fake-kernel-ports';
import { makeProviderReceipt } from '@tests/support/provider-receipt';
import { okValue } from '@tests/support/result';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplicationResult } from '@/modules/kernel';

const host = vi.hoisted(() => ({ getEnv: vi.fn(), waitUntil: vi.fn() }));
vi.mock('@vercel/functions', () => host);
vi.mock('workflow/api', () => ({ start: vi.fn(async () => ({})) }));
vi.mock('@/modules/kernel/workflows/backend', () => ({
  accountingDeliveryWorkflow: vi.fn(),
}));
import {
  createAccountingFacade,
  deferAccountingDelivery,
  withAccountingDelivery,
} from '@/composition/accounting-delivery';
import { AppError } from '@/modules/kernel';

const logger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
describe('accounting dispatch ownership', () => {
  it('returns the operation result before an HTTP background dispatch resolves', async () => {
    const gateway = createFakeProviderCallLog();
    const receipt = makeProviderReceipt();
    const tasks: (() => Promise<void>)[] = [];
    let published = false;
    const schedule = vi.fn(() => new Promise<void>(() => {}));
    const result = await withAccountingDelivery({
      accounting: gateway.accounting,
      logger: logger(),
      owner: 'http',
      schedule,
      defer: (task) => {
        tasks.push(task);
      },
      operation: async (accounting) => {
        await accounting.capture(receipt);
        published = true;
        return Result.Ok({ type: 'published' });
      },
    });
    expect(okValue(result)).toEqual({ type: 'published' });
    expect(published).toBe(true);
    expect(gateway.receipts.size).toBe(1);
    expect(gateway.calls.size).toBe(0);
    expect(tasks).toHaveLength(1);
    expect(schedule).not.toHaveBeenCalled();
  });
  it.each(['failed', 'superseded'])(
    'dispatches captured %s calls after the operation settles',
    async (outcome) => {
      const gateway = createFakeProviderCallLog();
      let settled = false;
      const schedule = vi.fn(async () => {
        expect(settled).toBe(true);
      });
      const result = await withAccountingDelivery({
        accounting: gateway.accounting,
        logger: logger(),
        owner: 'workflow',
        schedule,
        operation: async (
          accounting
        ): Promise<ApplicationResult<{ type: string }>> => {
          await accounting.capture(makeProviderReceipt());
          settled = true;
          return outcome === 'failed'
            ? Result.Error(
                new AppError({
                  code: 'COPY_FAILED',
                  category: 'system',
                  status: 500,
                })
              )
            : Result.Ok({ type: outcome });
        },
      });
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(result.isError()).toBe(outcome === 'failed');
    }
  );
  it('publishes before workflow queue delay and retains receipts when dispatch times out', async () => {
    vi.useFakeTimers();
    const gateway = createFakeProviderCallLog();
    const log = logger();
    let published = false;
    const scheduled = vi.fn(() => {
      expect(published).toBe(true);
      return new Promise<void>(() => {});
    });
    const result = withAccountingDelivery({
      accounting: gateway.accounting,
      logger: log,
      owner: 'workflow',
      schedule: scheduled,
      operation: async (accounting) => {
        await accounting.capture(makeProviderReceipt());
        published = true;
        return 'published';
      },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe('published');
    expect(gateway.receipts.size).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'provider_accounting.dispatch_failed' })
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('wraps newly exposed facade operations without a method allowlist', async () => {
    const gateway = createFakeProviderCallLog();
    host.getEnv.mockReturnValue({ VERCEL: '1', VERCEL_ENV: 'production' });
    const facade = createAccountingFacade({
      accounting: gateway.accounting,
      logger: logger(),
      owner: 'http',
      create: (accounting) => ({
        newlyAdded: async () => {
          await accounting.capture(makeProviderReceipt());
          return 'published';
        },
      }),
    });
    expect(await facade.newlyAdded()).toBe('published');
    expect(host.waitUntil).toHaveBeenCalledOnce();
    // Finish the bounded background dispatch without opening a real queue.
  });
  it('registers HTTP work with the supported host owner and skips unsupported lifetimes', async () => {
    const task = vi.fn(async () => {});
    const log = logger();
    host.getEnv.mockReturnValue({});
    deferAccountingDelivery(task, log);
    expect(task).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'provider_accounting.dispatch_deferred',
      })
    );
    host.getEnv.mockReturnValue({ VERCEL: '1', VERCEL_ENV: 'production' });
    deferAccountingDelivery(task, log);
    expect(task).toHaveBeenCalledOnce();
    expect(host.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
  it('preserves an HTTP result when host task registration throws', async () => {
    host.getEnv.mockReturnValue({ VERCEL: '1', VERCEL_ENV: 'production' });
    host.waitUntil.mockImplementation(() => {
      throw new Error('host unavailable');
    });
    const gateway = createFakeProviderCallLog();
    const log = logger();
    expect(
      await withAccountingDelivery({
        accounting: gateway.accounting,
        logger: log,
        owner: 'http',
        schedule: async () => {},
        operation: async (accounting) => {
          await accounting.capture(makeProviderReceipt());
          return 'published';
        },
      })
    ).toBe('published');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'provider_accounting.dispatch_failed' })
    );
  });
});
