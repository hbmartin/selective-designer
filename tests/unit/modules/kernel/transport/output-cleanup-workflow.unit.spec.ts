import { Result } from '@bloodyowl/boxed';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/modules/kernel';
const state = vi.hoisted(() => ({
  list: vi.fn(),
  process: vi.fn(),
  cutoff: vi.fn(),
  summary: vi.fn(),
}));
vi.mock('@/composition/render-output-cleanup', () => ({
  getRenderOutputCleanup: () => state,
}));
import { renderOutputCleanupWorkflow } from '@/modules/rendering/workflows/backend';
describe('render cleanup workflow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.cutoff.mockResolvedValue(
      Result.Ok({ type: 'cleanup_cutoff', before: '2026-11-06T07:00:00.000Z' })
    );
    state.summary.mockResolvedValue(
      Result.Ok({
        type: 'cleanup_summary',
        blockedTotal: 1,
        blockedOutstanding: 1,
        reasons: [],
        outstandingReasons: [],
      })
    );
  });
  it('uses the database snapshot and original tuple cursor while isolating failed and blocked work', async () => {
    const cursor = {
      nextAttemptAt: '2026-11-06T06:00:00.000Z',
      objectKey: 'z',
    };
    state.list
      .mockResolvedValueOnce(
        Result.Ok({ type: 'cleanup_page', ids: ['a', 'b', 'z'], cursor })
      )
      .mockResolvedValue(Result.Ok({ type: 'cleanup_empty', ids: [] }));
    state.process.mockImplementation(async (id) =>
      id === 'a'
        ? Result.Error(
            new AppError({ code: 'TEMPORARY', category: 'system', status: 503 })
          )
        : Result.Ok({
            type: id === 'b' ? 'cleanup_blocked' : 'cleanup_completed',
          })
    );
    const actual = await renderOutputCleanupWorkflow();
    expect(actual).toEqual({
      completed: 1,
      failed: 1,
      blockedThisRun: 1,
      blockedTotal: 1,
      blockedOutstanding: 1,
      blockedReasons: [],
      outstandingReasons: [],
    });
    expect(state.list).toHaveBeenNthCalledWith(2, {
      before: '2026-11-06T07:00:00.000Z',
      after: cursor,
    });
  });
  it('rejects a missing cursor before processing the malformed page', async () => {
    state.list.mockResolvedValue(
      Result.Ok({ type: 'cleanup_page', ids: ['a'] })
    );
    await expect(renderOutputCleanupWorkflow()).rejects.toThrow(
      'RENDER_CLEANUP_CURSOR_INVALID'
    );
    expect(state.process).not.toHaveBeenCalled();
  });
  it('stops a repeated cursor without processing a page twice', async () => {
    state.list.mockResolvedValue(
      Result.Ok({
        type: 'cleanup_page',
        ids: ['a'],
        cursor: { nextAttemptAt: '2000-01-01T00:00:00.000Z', objectKey: 'a' },
      })
    );
    state.process.mockResolvedValue(Result.Ok({ type: 'cleanup_completed' }));
    await expect(renderOutputCleanupWorkflow()).rejects.toThrow(
      'RENDER_CLEANUP_CURSOR_INVALID'
    );
    expect(state.process).toHaveBeenCalledOnce();
  });
  it('rejects a cyclic cursor before processing an earlier page again', async () => {
    const page = (id: string) =>
      Result.Ok({
        type: 'cleanup_page',
        ids: [id],
        cursor: { nextAttemptAt: '2000-01-01T00:00:00.123Z', objectKey: id },
      });
    state.list
      .mockResolvedValueOnce(page('a'))
      .mockResolvedValueOnce(page('b'))
      .mockResolvedValue(page('a'));
    state.process.mockResolvedValue(Result.Ok({ type: 'cleanup_completed' }));
    await expect(renderOutputCleanupWorkflow()).rejects.toThrow(
      'RENDER_CLEANUP_CURSOR_INVALID'
    );
    expect(state.process.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });
});
