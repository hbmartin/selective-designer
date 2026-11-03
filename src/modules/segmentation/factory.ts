import {
  carryOverRegions,
  detectConcept,
  detectionConceptsFor,
} from './application/use-cases/pipeline';
import {
  createManualRegion,
  listRegions,
  removeRegion,
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
    finishDetection: (imageId: Input<typeof detectionConceptsFor>) =>
      deps.regionRepository.finishDetection(imageId),
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
