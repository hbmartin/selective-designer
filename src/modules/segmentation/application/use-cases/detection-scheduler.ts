import { Result } from '@bloodyowl/boxed';

import type {
  ApplicationResult,
  Clock,
  IdGenerator,
  Logger,
} from '@/modules/kernel';
import type { ImageId } from '@/modules/kernel/domain/ids';

import { detectionConceptsFor } from './pipeline';
import { DETECTION_START_WINDOW_MS } from './types';
import type {
  AutoDetectionScheduler,
  ConceptSource,
  DetectionDispatch,
  DetectionLease,
  DetectionProgress,
  DetectionQueue,
  DetectionRetry,
  ImageAccess,
  RegionRepository,
} from '../ports/ports';

export const newDetectionProgress = (
  carryFromImageId: ImageId | null
): DetectionProgress => ({
  carryFromImageId,
  carryOverCompleted: carryFromImageId === null,
  concepts: null,
  completedConcepts: [],
});

export const createDetectionScheduler = (deps: {
  regionRepository: RegionRepository;
  queue: DetectionQueue;
  imageAccess: ImageAccess;
  conceptSource: ConceptSource;
  findCarrySource: (
    imageId: ImageId
  ) => Promise<
    ApplicationResult<
      | { type: 'carry_source_found'; imageId: ImageId }
      | { type: 'no_carry_source' }
    >
  >;
  idGenerator: IdGenerator;
  clock: Clock;
  logger: Logger;
}): AutoDetectionScheduler & DetectionRetry => {
  const enqueue = async (
    imageId: ImageId,
    runId: string
  ): Promise<ApplicationResult<DetectionDispatch>> => {
    const queued = await deps.queue.enqueue({ imageId, runId });
    if (queued.isError()) {
      deps.logger.warn({
        event: 'segmentation.detection.queue_acceptance_unknown',
        details: { imageId, runId, code: queued.getError().code },
      });
      return Result.Ok({ type: 'detection_queue_uncertain' });
    }
    if (queued.get().type === 'detection_not_enqueued') {
      const failed = await deps.regionRepository.failDispatch({
        imageId,
        runId,
      });
      if (failed.isError()) return Result.Error(failed.getError());
      return Result.Ok({ type: 'detection_queue_rejected' });
    }
    return Result.Ok({ type: 'auto_detection_scheduled' });
  };

  const claimDispatch = async (
    imageId: ImageId,
    lease: DetectionLease,
    initial: boolean,
    progress?: DetectionProgress
  ): Promise<
    ApplicationResult<
      { type: 'dispatch_claimed'; runId: string } | { type: 'dispatch_lost' }
    >
  > => {
    const id = deps.idGenerator.createId();
    if (id.isError()) return Result.Error(id.getError());
    const runId = id.get();
    const now = deps.clock.now();
    const claimed = await deps.regionRepository.resumeDetection({
      previous: { imageId, runId: lease.runId },
      runId,
      now,
      expiresAtMs: now.getTime() + DETECTION_START_WINDOW_MS,
      legacyProgress: progress,
      dispatch: { previousPhase: lease.phase, initial },
    });
    if (claimed.isError()) return Result.Error(claimed.getError());
    return Result.Ok(
      claimed.get().type === 'detection_started'
        ? { type: 'dispatch_claimed' as const, runId }
        : { type: 'dispatch_lost' as const }
    );
  };

  return {
    async schedule({ imageId }) {
      const found = await deps.regionRepository.findDetection(imageId);
      if (found.isError()) return Result.Error(found.getError());
      const lease = found.get();
      if (lease.type === 'no_detection') {
        return Result.Ok({ type: 'detection_intent_missing' });
      }
      if (lease.phase !== 'ready' && lease.phase !== 'copying') {
        return Result.Ok({ type: 'auto_detection_scheduled' });
      }
      const dispatch = await claimDispatch(imageId, lease, true);
      if (dispatch.isError()) return Result.Error(dispatch.getError());
      const claim = dispatch.get();
      return claim.type === 'dispatch_claimed'
        ? enqueue(imageId, claim.runId)
        : Result.Ok({ type: 'auto_detection_scheduled' });
    },

    async retry(imageId) {
      const found = await deps.regionRepository.findDetection(imageId);
      if (found.isError()) return Result.Error(found.getError());
      const lease = found.get();
      if (
        lease.type === 'no_detection' ||
        lease.phase === 'omissions' ||
        (lease.phase !== 'ready' &&
          !lease.failed &&
          lease.expiresAt > deps.clock.now())
      ) {
        return Result.Ok({ type: 'detection_not_retryable' });
      }

      let progress: DetectionProgress | undefined;
      if (!lease.progress) {
        const source = await deps.findCarrySource(imageId);
        if (source.isError()) return Result.Error(source.getError());
        const labels = await deps.regionRepository.detectionLabels(imageId);
        if (labels.isError()) return Result.Error(labels.getError());
        const carry = source.get();
        progress = {
          ...newDetectionProgress(
            carry.type === 'carry_source_found' ? carry.imageId : null
          ),
          completedConcepts: labels.get(),
        };
      } else if (lease.phase === 'copying') {
        const discovered = await detectionConceptsFor(deps, imageId);
        if (discovered.isError()) return Result.Error(discovered.getError());
        const outcome = discovered.get();
        if (outcome.type === 'image_missing')
          return Result.Ok({ type: 'detection_not_retryable' });
        // Freeze the partial copy before dispatch, even if the worker starts later.
        progress = { ...lease.progress, concepts: outcome.concepts };
      }

      const dispatched = await claimDispatch(imageId, lease, false, progress);
      if (dispatched.isError()) return Result.Error(dispatched.getError());
      const claim = dispatched.get();
      return claim.type === 'dispatch_claimed'
        ? enqueue(imageId, claim.runId)
        : Result.Ok({ type: 'detection_not_retryable' });
    },
  };
};
