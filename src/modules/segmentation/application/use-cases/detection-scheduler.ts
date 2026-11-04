import { Result } from '@bloodyowl/boxed';

import type {
  ApplicationResult,
  Clock,
  IdGenerator,
  Logger,
} from '@/modules/kernel';
import type { ImageId } from '@/modules/kernel/domain/ids';

import { detectionConceptsFor } from './pipeline';
import { DETECTION_LEASE_MS } from './types';
import type {
  AutoDetectionScheduler,
  ConceptSource,
  DetectionProgress,
  DetectionQueue,
  DetectionRetry,
  ImageAccess,
  RegionRepository,
} from '../ports/ports';

const newProgress = (carryFromImageId: ImageId | null): DetectionProgress => ({
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
  const enqueue = async (imageId: ImageId, runId: string) => {
    const queued = await deps.queue.enqueue({ imageId, runId });
    if (queued.isError()) {
      // The queue may have accepted the job before the error reached us.
      // The lease keeps that worker authorized and allows an owner retry later.
      deps.logger.warn({
        event: 'segmentation.detection.queue_acceptance_unknown',
        details: { imageId, runId, code: queued.getError().code },
      });
    }
    return Result.Ok({ type: 'auto_detection_scheduled' as const });
  };

  return {
    async schedule({ imageId, carryFromImageId }) {
      const id = deps.idGenerator.createId();
      if (id.isError()) return Result.Error(id.getError());
      const runId = id.get();
      const discovered = await detectionConceptsFor(deps, imageId);
      const progress = newProgress(carryFromImageId);
      if (discovered.isError()) {
        deps.logger.warn({
          event: 'segmentation.detection.concepts_unavailable',
          details: { imageId, runId, code: discovered.getError().code },
        });
      } else {
        const outcome = discovered.get();
        if (outcome.type === 'concepts') progress.concepts = outcome.concepts;
      }
      const started = await deps.regionRepository.startDetection({
        imageId,
        runId,
        expiresAtMs: deps.clock.now().getTime() + DETECTION_LEASE_MS,
        progress,
      });
      if (started.isError()) return Result.Error(started.getError());
      if (started.get().type === 'detection_already_started') {
        return Result.Ok({ type: 'auto_detection_scheduled' });
      }
      return enqueue(imageId, runId);
    },

    async retry(imageId) {
      const listed = await deps.regionRepository.listByImage(imageId);
      if (listed.isError()) return Result.Error(listed.getError());
      const { detectionState, detectionExpiresAt, regions } = listed.get();
      const now = deps.clock.now();
      if (
        !detectionState ||
        !detectionExpiresAt ||
        (!detectionState.failed && detectionExpiresAt.getTime() > now.getTime())
      ) {
        return Result.Ok({ type: 'detection_not_retryable' });
      }

      let legacyProgress: DetectionProgress | undefined;
      if (!detectionState.progress) {
        const source = await deps.findCarrySource(imageId);
        if (source.isError()) return Result.Error(source.getError());
        const found = source.get();
        legacyProgress = {
          ...newProgress(
            found.type === 'carry_source_found' ? found.imageId : null
          ),
          completedConcepts: [
            ...new Set(
              regions
                .filter((region) => region.source === 'detection')
                .map((region) => region.label)
            ),
          ],
        };
      }

      const id = deps.idGenerator.createId();
      if (id.isError()) return Result.Error(id.getError());
      const runId = id.get();
      const claimedAt = deps.clock.now();
      const claimed = await deps.regionRepository.resumeDetection({
        previous: { imageId, runId: detectionState.runId },
        runId,
        now: claimedAt,
        expiresAtMs: claimedAt.getTime() + DETECTION_LEASE_MS,
        legacyProgress,
      });
      if (claimed.isError()) return Result.Error(claimed.getError());
      return claimed.get().type === 'detection_started'
        ? enqueue(imageId, runId)
        : Result.Ok({ type: 'detection_not_retryable' });
    },
  };
};
