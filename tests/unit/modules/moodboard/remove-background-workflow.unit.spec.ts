import { Result } from '@bloodyowl/boxed';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/modules/kernel';
import { removeBackgroundWorkflow } from '@/modules/moodboard/testing';

const pipeline = vi.hoisted(() => ({
  removeBackground: vi.fn(),
  markCutoutFailed: vi.fn(),
}));
vi.mock('workflow', () => ({
  FatalError: class FatalError extends Error {},
  RetryableError: class RetryableError extends Error {},
}));
vi.mock('@/composition/moodboard-pipeline', () => ({
  getMoodboardPipelineUseCases: () => pipeline,
}));

describe('background removal workflow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('marks the same attempt retryable when its step fails for good', async () => {
    pipeline.removeBackground.mockResolvedValue(
      Result.Error(
        new AppError({
          code: 'PROVIDER_UNAVAILABLE',
          category: 'system',
          status: 503,
          message: 'Provider unavailable',
        })
      )
    );
    pipeline.markCutoutFailed.mockResolvedValue(
      Result.Ok({ type: 'cutout_marked_failed' })
    );
    const input = { itemVersionId: 'version', attemptId: 'attempt' };
    expect(await removeBackgroundWorkflow(input)).toEqual({
      type: 'cutout_failed',
      reason: 'workflow_step_failed',
    });
    expect(pipeline.removeBackground).toHaveBeenCalledExactlyOnceWith({
      versionId: input.itemVersionId,
      attemptId: input.attemptId,
    });
    expect(pipeline.markCutoutFailed).toHaveBeenCalledExactlyOnceWith({
      versionId: input.itemVersionId,
      attemptId: input.attemptId,
      failureCode: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('treats legacy workflow inputs as null attempts', async () => {
    pipeline.removeBackground.mockResolvedValue(
      Result.Ok({ type: 'cutout_ready' })
    );
    expect(
      await removeBackgroundWorkflow({ itemVersionId: 'legacy-version' })
    ).toEqual({ type: 'cutout_ready' });
    expect(pipeline.removeBackground).toHaveBeenCalledExactlyOnceWith({
      versionId: 'legacy-version',
      attemptId: null,
    });
    expect(pipeline.markCutoutFailed).not.toHaveBeenCalled();
  });
});
