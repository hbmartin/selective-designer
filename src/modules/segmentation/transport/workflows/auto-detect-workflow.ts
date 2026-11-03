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

async function carryOverStep(fromImageId: string, toImageId: string) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).carryOver({
      fromImageId: imageIdOrFail(fromImageId),
      toImageId: imageIdOrFail(toImageId),
    })
  );
}

async function conceptsStep(imageId: string) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).concepts(imageIdOrFail(imageId))
  );
}

async function detectConceptStep(imageId: string, concept: string) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).detectConcept({ imageId: imageIdOrFail(imageId), concept })
  );
}

async function finishDetectionStep(imageId: string) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).finishDetection(imageIdOrFail(imageId))
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
}) {
  'use workflow';
  try {
    if (input.carryFromImageId) {
      await carryOverStep(input.carryFromImageId, input.imageId);
    }
    const concepts = await conceptsStep(input.imageId);
    if (concepts.type === 'image_missing') return { detected: 0 };
    const results = await Promise.allSettled(
      concepts.concepts.map((concept) =>
        detectConceptStep(input.imageId, concept)
      )
    );
    return {
      detected: results.filter((result) => result.status === 'fulfilled')
        .length,
      failed: results.filter((result) => result.status === 'rejected').length,
    };
  } finally {
    await finishDetectionStep(input.imageId);
  }
}
