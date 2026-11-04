import { Result } from '@bloodyowl/boxed';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/modules/kernel';
import { autoDetectWorkflow } from '@/modules/segmentation/testing';

const pipeline = vi.hoisted(() => ({
  carryOver: vi.fn(),
  concepts: vi.fn(),
  detectConcept: vi.fn(),
  finishDetection: vi.fn(),
}));

vi.mock('workflow', () => ({
  FatalError: class FatalError extends Error {},
  RetryableError: class RetryableError extends Error {},
}));
vi.mock('@/composition/segmentation-pipeline', () => ({
  getSegmentationPipelineUseCases: () => pipeline,
}));

const run = { imageId: 'image', runId: 'run', carryFromImageId: null };

const failure = (code: string) =>
  Result.Error(
    new AppError({
      code,
      category: 'system',
      status: 503,
      message: 'Unavailable',
    })
  );

describe('automatic detection workflow cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    pipeline.finishDetection.mockResolvedValue(
      Result.Ok({ type: 'detection_finished' })
    );
  });

  it('releases the matching lease after publishing detections', async () => {
    pipeline.concepts.mockResolvedValue(
      Result.Ok({ type: 'concepts', concepts: ['chair'] })
    );
    pipeline.detectConcept.mockResolvedValue(
      Result.Ok({ type: 'concept_detected', count: 1 })
    );
    expect(await autoDetectWorkflow(run)).toEqual({ detected: 1, failed: 0 });
    expect(pipeline.detectConcept).toHaveBeenCalledExactlyOnceWith({
      imageId: run.imageId,
      concept: 'chair',
      runId: run.runId,
    });
    expect(pipeline.finishDetection).toHaveBeenCalledExactlyOnceWith({
      imageId: run.imageId,
      runId: run.runId,
    });
  });

  it('releases the lease on the missing image early return', async () => {
    pipeline.concepts.mockResolvedValue(Result.Ok({ type: 'image_missing' }));
    expect(await autoDetectWorkflow(run)).toEqual({ detected: 0 });
    expect(pipeline.finishDetection).toHaveBeenCalledExactlyOnceWith({
      imageId: run.imageId,
      runId: run.runId,
    });
  });

  it('keeps the original error if the lease release also fails', async () => {
    pipeline.carryOver.mockResolvedValue(failure('CARRY_OVER_FAILED'));
    pipeline.finishDetection.mockResolvedValue(failure('CLEANUP_FAILED'));
    await expect(
      autoDetectWorkflow({ ...run, carryFromImageId: 'parent' })
    ).rejects.toThrow(/CARRY_OVER_FAILED/);
    expect(pipeline.finishDetection).toHaveBeenCalledExactlyOnceWith({
      imageId: run.imageId,
      runId: run.runId,
    });
  });

  it('preserves success if only the lease release fails', async () => {
    pipeline.concepts.mockResolvedValue(
      Result.Ok({ type: 'concepts', concepts: [] })
    );
    pipeline.finishDetection.mockResolvedValue(failure('CLEANUP_FAILED'));
    expect(await autoDetectWorkflow(run)).toEqual({ detected: 0, failed: 0 });
    expect(pipeline.finishDetection).toHaveBeenCalledOnce();
  });
});
