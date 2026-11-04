import { Result } from '@bloodyowl/boxed';

import type { DetectionRun } from './application/ports/ports';
import {
  carryOverRegions,
  detectConcept,
  detectionConceptsFor,
} from './application/use-cases/pipeline';
import {
  createManualRegion,
  listRegions,
  removeRegion,
  retryDetection,
  segmentByPrompt,
  updateRegion,
} from './application/use-cases/regions';
import type {
  SegmentationPipelineDeps,
  SegmentationUseCaseDeps,
} from './application/use-cases/types';

type Input<TFn extends (deps: never, input: never) => unknown> =
  Parameters<TFn>[1];

export function createSegmentationUseCases(deps: SegmentationUseCaseDeps) {
  return {
    retryDetection: (input: Input<typeof retryDetection>) =>
      retryDetection(deps, input),
    list: (input: Input<typeof listRegions>) => listRegions(deps, input),
    segment: (input: Input<typeof segmentByPrompt>) =>
      segmentByPrompt(deps, input),
    createManual: (input: Input<typeof createManualRegion>) =>
      createManualRegion(deps, input),
    update: (input: Input<typeof updateRegion>) => updateRegion(deps, input),
    remove: (input: Input<typeof removeRegion>) => removeRegion(deps, input),
  };
}
export type SegmentationUseCases = ReturnType<
  typeof createSegmentationUseCases
>;

export function createSegmentationPipelineUseCases(
  deps: SegmentationPipelineDeps
) {
  return {
    async prepareDetection(run: DetectionRun) {
      const listed = await deps.regionRepository.listByImage(run.imageId);
      if (listed.isError()) return Result.Error(listed.getError());
      const state = listed.get().detectionState;
      if (!state?.progress || state.runId !== run.runId || state.failed)
        return Result.Ok({ type: 'detection_superseded' } as const);
      let concepts = state.progress.concepts;
      if (concepts === null) {
        const discovered = await detectionConceptsFor(deps, run.imageId);
        if (discovered.isError()) return Result.Error(discovered.getError());
        const outcome = discovered.get();
        if (outcome.type === 'image_missing')
          return Result.Ok({ type: 'detection_superseded' } as const);
        concepts = outcome.concepts;
      }
      return deps.regionRepository.prepareDetection({
        ...run,
        concepts,
        now: deps.clock.now(),
      });
    },
    async finalizeDetection(run: DetectionRun) {
      const outcome = await deps.regionRepository.finalizeDetection({
        ...run,
        now: deps.clock.now(),
      });
      if (outcome.isError()) {
        deps.logger.warn({
          event: 'segmentation.detection.finalize_failed',
          details: run,
          exception: outcome.getError(),
        });
      }
      return outcome;
    },
    async finishDetection(run: DetectionRun) {
      const finished = await deps.regionRepository.finishDetection({
        ...run,
        now: deps.clock.now(),
      });
      if (finished.isError()) {
        deps.logger.warn({
          event: 'segmentation.detection.cleanup_failed',
          details: run,
          exception: finished.getError(),
        });
      }
      return finished;
    },
    concepts: (imageId: Input<typeof detectionConceptsFor>) =>
      detectionConceptsFor(deps, imageId),
    detectConcept: (input: Input<typeof detectConcept>) =>
      detectConcept(deps, input),
    carryOver: (input: Input<typeof carryOverRegions>) =>
      carryOverRegions(deps, input),
  };
}
export type SegmentationPipelineUseCases = ReturnType<
  typeof createSegmentationPipelineUseCases
>;
