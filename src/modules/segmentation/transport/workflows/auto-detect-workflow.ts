import { FatalError } from 'workflow';

import { toImageId } from '@/modules/kernel/domain/ids';
import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';

const imageIdOrFail = (value: string) => {
  const id = toImageId(value);
  if (id.isError()) throw new FatalError(`Invalid image id: ${value}`);
  return id.get();
};

const pipeline = async () =>
  (
    await import('@/composition/segmentation-pipeline')
  ).getSegmentationPipelineUseCases();

async function carryOverStep(
  fromImageId: string,
  toImageId: string,
  runId: string | null = null
) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).carryOver({
      fromImageId: imageIdOrFail(fromImageId),
      toImageId: imageIdOrFail(toImageId),
      runId,
    })
  );
}

async function conceptsStep(imageId: string) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).concepts(imageIdOrFail(imageId))
  );
}

async function detectConceptStep(
  imageId: string,
  concept: string,
  runId: string | null = null
) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).detectConcept({ imageId: imageIdOrFail(imageId), concept, runId })
  );
}

async function finishDetectionStep(
  imageId: string,
  runId: string | null = null
) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).finishDetection({ imageId: imageIdOrFail(imageId), runId })
  );
}

/**
 * Eager segmentation of a new image: carry the render source's user-made
 * regions over (results only), then detect every concept in parallel. One
 * concept failing does not affect the others.
 */
export async function autoDetectWorkflow(input: {
  imageId: string;
  carryFromImageId: string | null;
  runId?: string;
}) {
  'use workflow';
  try {
    if (input.carryFromImageId) {
      if (input.runId === undefined)
        await carryOverStep(input.carryFromImageId, input.imageId);
      else
        await carryOverStep(input.carryFromImageId, input.imageId, input.runId);
    }
    const concepts = await conceptsStep(input.imageId);
    if (concepts.type === 'image_missing') return { detected: 0 };
    const results = await Promise.allSettled(
      concepts.concepts.map((concept) =>
        input.runId === undefined
          ? detectConceptStep(input.imageId, concept)
          : detectConceptStep(input.imageId, concept, input.runId)
      )
    );
    return {
      detected: results.filter(
        (result) =>
          result.status === 'fulfilled' &&
          result.value.type === 'concept_detected'
      ).length,
      failed: results.filter(
        (result) =>
          result.status === 'rejected' || result.value.type === 'concept_failed'
      ).length,
    };
  } finally {
    try {
      if (input.runId === undefined) await finishDetectionStep(input.imageId);
      else await finishDetectionStep(input.imageId, input.runId);
    } catch {
      // The cleanup step logs persistence errors. Preserve the detection outcome.
    }
  }
}
