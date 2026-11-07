import { describe, expect, it, vi } from 'vitest';

vi.unmock('@/modules/kernel/infrastructure/db/client');

import { AppError } from '@/modules/kernel';
import type { Database } from '@/modules/kernel/infrastructure/db/types';
import { lazyModule } from '@/modules/kernel/transport/workflow/lazy-module';
import {
  safeBlockedObjectKey,
  safeRenderIdentity,
  validateCleanupPage,
} from '@/modules/rendering';
import {
  encodeBlockedCursor,
  parseRenderCleanupCommand,
  runRenderCleanupSweep,
} from '@/modules/rendering/backend';
import {
  createOutputCleanupStore,
  SubmissionPersistenceError,
  SubmissionWriteError,
} from '@/modules/rendering/testing';

describe('cleanup and recovery contracts', () => {
  it.each([
    'https://host/output?token=secret',
    '//host/x',
    '/absolute/key',
    'results/a/../raw.png',
    'results//a.png',
    'results/a%2fb.png',
    'results/a?x',
    'results/a#x',
    'results/a\\b',
    'results/a\nb',
    ' results/a.png',
    'results/a.png ',
    'secret',
    {},
    null,
    undefined,
    'results/' + 'x'.repeat(1024),
  ])('never retains unsafe locator %j', (value) => {
    expect(safeBlockedObjectKey(value)).toBeNull();
  });
  it('retains exact safe locators separately from deletion eligibility', () => {
    expect(safeBlockedObjectKey('region-masks/a.png')).toBe(
      'region-masks/a.png'
    );
    expect(safeBlockedObjectKey('results/a/1/raw.png')).toBe(
      'results/a/1/raw.png'
    );
    expect(
      safeRenderIdentity({ resultId: 'https://secret', attempt: -1 })
    ).toEqual({ resultId: undefined, attempt: undefined });
    expect(
      safeRenderIdentity({ resultId: 'a', attempt: 2147483648 }).attempt
    ).toBeUndefined();
  });
  it.each([
    ['typo'],
    ['acknowledge', 'a'.repeat(64), '--request-id'],
    ['requeue', 'a'.repeat(64), 'x', '1', '--request-id'],
    ['acknowledge', 'a'.repeat(64), '--request-id', '--outstanding'],
    ['blocked', '--after'],
    ['blocked', '0'],
    ['blocked', '101'],
    ['blocked', '1', 'extra'],
    ['inspect', 'bad'],
    ['requeue', 'a'.repeat(64), 'x', '0'],
    ['requeue', 'a'.repeat(64), 'x', '2147483648'],
    ['requeue', 'a'.repeat(64), 'x', '1', 'results/x/1/raw.png'],
  ])('rejects invalid operator args before execution: %j', (...args) => {
    expect(parseRenderCleanupCommand(args).isError()).toBe(true);
  });
  it('accepts only the documented commands', () => {
    for (const args of [
      [],
      ['blocked'],
      ['blocked', '3'],
      ['inspect', 'a'.repeat(64)],
      ['requeue', 'a'.repeat(64), 'result-a', '2'],
    ])
      expect(parseRenderCleanupCommand(args).isOk()).toBe(true);
  });
  it('rejects absent or repeated page cursors before processing', () => {
    const cursor = {
      nextAttemptAt: '2000-01-01T00:00:00.123Z',
      objectKey: 'x',
    };
    expect(validateCleanupPage({ ids: ['x'] }).isError()).toBe(true);
    expect(validateCleanupPage({ ids: ['x'], cursor }, cursor).isError()).toBe(
      true
    );
    expect(validateCleanupPage({ ids: ['y'], cursor }).isError()).toBe(true);
    expect(validateCleanupPage({ ids: ['x'], cursor }).isOk()).toBe(true);
    expect(validateCleanupPage({ ids: [] }).isOk()).toBe(true);
  });
  it.each(['persistence', 'write'] as const)(
    'preserves diagnostic and disclosure metadata inside the %s error',
    (kind) => {
      const cause = new AppError({
        code: 'WRITE_FAILED',
        category: 'system',
        status: 503,
        message: 'Useful internal context',
        details: { phase: 'write' },
        exposeDetails: true,
        retryable: false,
        retryAfterMs: 100,
        cause: new Error('transport'),
      });
      const wrapped =
        kind === 'persistence'
          ? new SubmissionPersistenceError(cause, true)
          : new SubmissionWriteError(cause, 'unknown');
      expect(wrapped).toMatchObject({
        code: cause.code,
        message: cause.message,
        details: cause.details,
        exposeDetails: true,
        retryable: false,
        retryAfterMs: 100,
        cause,
      });
    }
  );
  it('fails closed for metadata-less roots before SQL', async () => {
    const select = vi.fn();
    const update = vi.fn();
    const store = createOutputCleanupStore({
      db: { select, update } as unknown as Database,
    });
    expect(
      (await store.claim({ cleanupId: 'x', claimId: 'claim' })).isError()
    ).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it('uses the root transaction runner even when the HTTP driver is not transaction capable', async () => {
    const query = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    const select = vi.fn(() => query);
    const runner = vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({ select })
    );
    const rootSelect = vi.fn();
    const db = {
      $driver: 'neon-http',
      $transactionCapable: false,
      $runInTransaction: runner,
      select: rootSelect,
    } as unknown as Database;
    const result = await createOutputCleanupStore({ db }).claim({
      cleanupId: 'x',
      claimId: 'a',
    });
    expect(result.isOk() && result.get()).toEqual({
      type: 'cleanup_unavailable',
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(rootSelect).not.toHaveBeenCalled();
  });
  it('shares module loading and retries a failed load without caching failure', async () => {
    const original = new Error('load failed');
    const load = vi
      .fn()
      .mockRejectedValueOnce(original)
      .mockResolvedValue({ ready: true });
    const get = lazyModule(load);
    const first = get();
    expect(get()).toBe(first);
    await expect(first).rejects.toBe(original);
    await expect(get()).resolves.toEqual({ ready: true });
    await expect(get()).resolves.toEqual({ ready: true });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('accepts paged operator browsing and explicit replay identities, rejecting unknown flags', () => {
    const requestId = '7a2b2513-6c27-4ce9-b183-48b1698796b1';
    const token = encodeBlockedCursor({
      createdAt: '2026-11-07T01:02:03.123Z',
      fingerprint: 'a'.repeat(64),
    });
    for (const args of [
      ['blocked', '50', '--outstanding', '--after', token],
      ['acknowledge', 'a'.repeat(64), '--request-id', requestId],
      ['requeue', 'a'.repeat(64), 'result-a', '1', '--request-id', requestId],
    ])
      expect(parseRenderCleanupCommand(args).isOk()).toBe(true);
    for (const args of [
      ['blocked', '--after', 'bad'],
      ['blocked', '--request-id', requestId],
      ['acknowledge', 'a'.repeat(64), '--request-id', 'bad'],
      ['blocked', '--outstanding', '--outstanding'],
      ['blocked', '--unknown'],
    ])
      expect(parseRenderCleanupCommand(args).isError()).toBe(true);
  });
  it('keeps the cursor application error code for the operator sweep', async () => {
    const process = vi.fn();
    const sweep = runRenderCleanupSweep(
      {
        cutoff: async () => '2026-11-07T00:00:00Z',
        list: async () => ({ type: 'cleanup_page', ids: ['a'] }) as never,
        process,
        summary: async () => ({
          blockedTotal: 0,
          blockedOutstanding: 0,
          reasons: [],
          outstandingReasons: [],
        }),
      },
      1
    );
    await expect(sweep).rejects.toMatchObject({
      code: 'RENDER_CLEANUP_CURSOR_INVALID',
      retryable: false,
    });
    expect(process).not.toHaveBeenCalled();
  });
});
