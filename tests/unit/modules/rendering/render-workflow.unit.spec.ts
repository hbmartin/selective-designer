import { beforeEach, describe, expect, it, vi } from 'vitest';

type Outcome = { type: string; [key: string]: unknown };

const pipeline = vi.hoisted(() => ({
  runnable: vi.fn<(id: string) => Promise<unknown>>(),
  submit: vi.fn<(id: string) => Promise<unknown>>(),
  poll: vi.fn<(id: string) => Promise<unknown>>(),
  markFailed:
    vi.fn<(input: { resultId: string; reason: string }) => Promise<unknown>>(),
}));

vi.mock('workflow', () => ({
  FatalError: class FatalError extends Error {},
  RetryableError: class RetryableError extends Error {},
  sleep: vi.fn(async () => {}),
}));
vi.mock('@/composition/rendering-pipeline', () => ({
  getRenderingPipelineUseCases: () => pipeline,
}));

const { Result } = await import('@bloodyowl/boxed');
const { renderResultWorkflow, renderWorkflow, MAX_POLLS, pollDelayMs } =
  await import('@/modules/rendering/testing');

const ok = (value: Outcome) => Promise.resolve(Result.Ok(value));

describe('render workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pipeline.markFailed.mockImplementation(() =>
      ok({ type: 'result_marked_failed' })
    );
  });

  it('runs every runnable result independently', async () => {
    pipeline.runnable.mockImplementation(() =>
      ok({ type: 'runnable', resultIds: ['res-a', 'res-b'] })
    );
    pipeline.submit.mockImplementation(() => ok({ type: 'result_submitted' }));
    const polls: Record<string, Outcome[]> = {
      'res-a': [{ type: 'result_pending' }, { type: 'result_succeeded' }],
      'res-b': [{ type: 'result_failed', reason: 'moderated' }],
    };
    pipeline.poll.mockImplementation((id) =>
      ok(polls[id]?.shift() ?? { type: 'result_pending' })
    );

    expect(await renderWorkflow({ renderId: 'render-1' })).toEqual({
      results: ['result_succeeded', 'result_failed'],
    });
    expect(pipeline.poll).toHaveBeenCalledTimes(3);
    expect(pipeline.markFailed).not.toHaveBeenCalled();
  });

  it('marks only the failing result failed when a step fails for good', async () => {
    pipeline.submit.mockImplementation(() =>
      Promise.resolve(
        Result.Error({
          code: 'BAD',
          category: 'validation',
          status: 400,
          message: 'nope',
        })
      )
    );
    expect(await renderResultWorkflow({ resultId: 'res-a' })).toEqual({
      result: 'result_failed',
    });
    expect(pipeline.markFailed).toHaveBeenCalledWith({
      resultId: 'res-a',
      reason: 'BAD: nope',
    });
  });

  it('stops after a rejected submit without polling', async () => {
    pipeline.submit.mockImplementation(() =>
      ok({ type: 'result_failed', reason: 'rejected' })
    );
    expect(await renderResultWorkflow({ resultId: 'res-a' })).toEqual({
      result: 'result_failed',
    });
    expect(pipeline.poll).not.toHaveBeenCalled();
  });

  it('times out after the polling budget', async () => {
    pipeline.submit.mockImplementation(() => ok({ type: 'result_submitted' }));
    pipeline.poll.mockImplementation(() => ok({ type: 'result_pending' }));
    expect(await renderResultWorkflow({ resultId: 'res-a' })).toEqual({
      result: 'result_failed',
    });
    expect(pipeline.poll).toHaveBeenCalledTimes(MAX_POLLS);
    expect(pipeline.markFailed).toHaveBeenCalledWith({
      resultId: 'res-a',
      reason: 'timed_out',
    });
  });

  it('backs off from 2 s to 10 s', () => {
    expect([0, 1, 5, 8, 100].map(pollDelayMs)).toEqual([
      2000, 3000, 7000, 10_000, 10_000,
    ]);
  });
});
