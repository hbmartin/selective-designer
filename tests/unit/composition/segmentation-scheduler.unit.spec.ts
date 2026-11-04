import { okValue } from '@tests/support/result';
import { describe, expect, it, vi } from 'vitest';
import type { getWorld } from 'workflow/runtime';

import { enqueueDetectionWorkflow } from '@/composition/segmentation-scheduler';
import { toImageId } from '@/modules/kernel/domain/ids';

vi.mock('@/modules/segmentation/workflows/backend', () => ({
  claimedAutoDetectWorkflow: Object.assign(() => {}, {
    workflowId: 'workflow//./test//claimedDetection',
  }),
}));

const input = { imageId: okValue(toImageId('image-1')), runId: 'attempt-1' };

const fakeWorld = () => {
  const queue = vi.fn(async () => ({ messageId: 'test-message' }));
  const getDeploymentId = vi.fn(async () => 'test');
  const create = vi.fn(async (runId: string) => ({ run: { runId } }));
  // Only the World operations the actual pinned SDK uses during start.
  const world = { specVersion: 6, getDeploymentId, queue, events: { create } };
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const enqueue = () =>
    enqueueDetectionWorkflow(
      input,
      logger,
      async () => world as unknown as Awaited<ReturnType<typeof getWorld>>
    );
  return { enqueue, queue, create, getDeploymentId, logger };
};

describe('detection dispatch against the Workflow SDK', () => {
  it('reports a pre-queue failure as definite', async () => {
    const world = fakeWorld();
    world.getDeploymentId.mockRejectedValueOnce(new Error('unavailable'));
    expect(okValue(await world.enqueue()).type).toBe('detection_not_enqueued');
    expect(world.queue).not.toHaveBeenCalled();
    expect(world.logger.warn).toHaveBeenCalledOnce();
  });

  it('treats rejection after entering the queue method as uncertain', async () => {
    const world = fakeWorld();
    world.queue.mockRejectedValueOnce(new Error('response lost'));
    const result = await world.enqueue();
    expect(result.isError() && result.getError().code).toBe(
      'WORKFLOW_START_FAILED'
    );
    expect(world.queue).toHaveBeenCalledOnce();
  });

  it('treats run creation failure after publication as uncertain', async () => {
    const world = fakeWorld();
    world.create.mockRejectedValueOnce(new Error('failed to record run'));
    const result = await world.enqueue();
    expect(result.isError() && result.getError().code).toBe(
      'WORKFLOW_START_FAILED'
    );
    expect(world.queue).toHaveBeenCalledOnce();
  });

  it('reports a successful enqueue', async () => {
    const world = fakeWorld();
    expect(okValue(await world.enqueue()).type).toBe('detection_enqueued');
    expect(world.queue).toHaveBeenCalledOnce();
  });
});
