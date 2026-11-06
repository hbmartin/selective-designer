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
    await expect(removeBackgroundWorkflow(input)).rejects.toThrow(
      'PROVIDER_UNAVAILABLE: Background removal workflow failed'
    );
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
  it('keeps the original code after SDK retry exhaustion', async () => {
    const original = new Error('OBJECT_COPY_SOURCE_FAILED: safe source error');
    pipeline.removeBackground.mockRejectedValue(
      new Error(
        'Step "removeBackgroundStep" failed after 3 retries: OBJECT_COPY_SOURCE_FAILED: safe source error',
        { cause: original }
      )
    );
    pipeline.markCutoutFailed.mockResolvedValue(
      Result.Ok({ type: 'cutout_marked_failed' })
    );
    await expect(
      removeBackgroundWorkflow({
        itemVersionId: 'version',
        attemptId: 'attempt',
      })
    ).rejects.toThrow(
      'OBJECT_COPY_SOURCE_FAILED: Background removal workflow failed'
    );
    expect(pipeline.markCutoutFailed).toHaveBeenCalledWith({
      versionId: 'version',
      attemptId: 'attempt',
      failureCode: 'OBJECT_COPY_SOURCE_FAILED',
    });
  });
});
