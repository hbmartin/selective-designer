import { FatalError, getWorkflowMetadata } from 'workflow';

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

async function prepareDetectionStep(imageId: string, runId: string) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).prepareDetection({ imageId: imageIdOrFail(imageId), runId })
  );
}

async function finalizeDetectionStep(imageId: string, runId: string) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).finalizeDetection({ imageId: imageIdOrFail(imageId), runId })
  );
}

/** Separate entry point so previously queued jobs keep their original steps. */
export async function recoverableAutoDetectWorkflow(input: {
  imageId: string;
  runId: string;
}) {
  'use workflow';
  const { imageId, runId } = input;
  try {
    const prepared = await prepareDetectionStep(imageId, runId);
    if (prepared.type === 'detection_superseded') return;
    const progress = prepared.progress;
    if (!progress.carryOverCompleted && progress.carryFromImageId) {
      const carried = await carryOverStep(
        progress.carryFromImageId,
        imageId,
        runId
      );
      if (carried.type !== 'regions_carried_over') return;
    }
    const remaining = (progress.concepts ?? []).filter(
      (concept) => !progress.completedConcepts.includes(concept)
    );
    await Promise.allSettled(
      remaining.map((concept) => detectConceptStep(imageId, concept, runId))
    );
  } finally {
    // A terminal worker outcome is retryable if any durable checkpoint is missing.
    // If even that write fails, the lease can still be reclaimed on expiry.
    try {
      await finalizeDetectionStep(imageId, runId);
    } catch {
      // The step logs persistence errors and preserves the primary outcome.
    }
  }
}

type ClaimedAttempt = { imageId: string; runId: string; workerId: string };

const attemptRun = ({ imageId, ...attempt }: ClaimedAttempt) => ({
  ...attempt,
  imageId: imageIdOrFail(imageId),
});

async function claimAttemptStep(attempt: ClaimedAttempt) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).claimDetection(attemptRun(attempt))
  );
}

async function prepareAttemptStep(attempt: ClaimedAttempt) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).prepareDetection(attemptRun(attempt))
  );
}

async function carryAttemptStep(attempt: ClaimedAttempt, fromImageId: string) {
  'use step';
  const { imageId, ...owner } = attemptRun(attempt);
  return unwrapStepResult(
    await (
      await pipeline()
    ).carryOver({
      ...owner,
      fromImageId: imageIdOrFail(fromImageId),
      toImageId: imageId,
    })
  );
}

async function detectAttemptConceptStep(
  attempt: ClaimedAttempt,
  concept: string
) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).detectConcept({ ...attemptRun(attempt), concept })
  );
}

async function finalizeAttemptStep(attempt: ClaimedAttempt) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).finalizeDetection(attemptRun(attempt))
  );
}

/** New queue deliveries claim an attempt before doing provider or storage work. */
export async function claimedAutoDetectWorkflow(input: {
  imageId: string;
  runId: string;
}) {
  'use workflow';
  const attempt = { ...input, workerId: getWorkflowMetadata().workflowRunId };
  const claim = await claimAttemptStep(attempt);
  if (claim.type !== 'detection_started') return;
  try {
    const prepared = await prepareAttemptStep(attempt);
    if (prepared.type === 'detection_superseded') return;
    const progress = prepared.progress;
    if (!progress.carryOverCompleted && progress.carryFromImageId) {
      const carried = await carryAttemptStep(
        attempt,
        progress.carryFromImageId
      );
      if (carried.type !== 'regions_carried_over') return;
    }
    const remaining = (progress.concepts ?? []).filter(
      (concept) =>
        !progress.completedConcepts.includes(concept) &&
        !progress.omissions?.some((omission) => omission.concept === concept)
    );
    await Promise.allSettled(
      remaining.map((concept) => detectAttemptConceptStep(attempt, concept))
    );
  } finally {
    try {
      await finalizeAttemptStep(attempt);
    } catch {
      // Finalization logs persistence errors. A failed write remains recoverable on expiry.
    }
  }
}
