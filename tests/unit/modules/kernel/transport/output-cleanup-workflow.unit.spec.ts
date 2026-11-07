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
      Result.Ok({ type: 'cleanup_summary', blocked: 1, reasons: [] })
    );
  });
  it('uses the database snapshot and original tuple cursor while isolating failed and blocked work', async () => {
    const cursor = {
      nextAttemptAt: '2026-11-06T06:00:00.000Z',
      objectKey: 'z',
    };
    state.list
      .mockResolvedValueOnce(
        Result.Ok({ type: 'cleanup_listed', ids: ['a', 'b', 'z'], cursor })
      )
      .mockResolvedValue(Result.Ok({ type: 'cleanup_listed', ids: [] }));
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
    expect(actual).toEqual({ completed: 1, failed: 1, blocked: 1 });
    expect(state.list).toHaveBeenNthCalledWith(2, {
      before: '2026-11-06T07:00:00.000Z',
      after: cursor,
    });
  });
});
