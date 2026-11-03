import { FatalError } from 'workflow';

import { toItemVersionId } from '@/modules/kernel/domain/ids';
import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';

const versionIdOrFail = (value: string) => {
  const id = toItemVersionId(value);
  if (id.isError()) throw new FatalError(`Invalid item version id: ${value}`);
  return id.get();
};

/** The step loads worker-only composition without request dependencies. */
async function removeBackgroundStep(
  itemVersionId: string,
  attemptId: string | null = null
) {
  'use step';
  const { getMoodboardPipelineUseCases } =
    await import('@/composition/moodboard-pipeline');
  return unwrapStepResult(
    await getMoodboardPipelineUseCases().removeBackground({
      versionId: versionIdOrFail(itemVersionId),
      attemptId,
    })
  );
}

async function markCutoutFailedStep(
  itemVersionId: string,
  attemptId: string | null
) {
  'use step';
  const { getMoodboardPipelineUseCases } =
    await import('@/composition/moodboard-pipeline');
  return unwrapStepResult(
    await getMoodboardPipelineUseCases().markCutoutFailed({
      versionId: versionIdOrFail(itemVersionId),
      attemptId,
    })
  );
}

export async function removeBackgroundWorkflow(input: {
  itemVersionId: string;
  attemptId?: string;
}) {
  'use workflow';
  try {
    // Preserve the original step arguments for in-flight legacy runs.
    return input.attemptId === undefined
      ? await removeBackgroundStep(input.itemVersionId)
      : await removeBackgroundStep(input.itemVersionId, input.attemptId);
  } catch {
    const failed = await markCutoutFailedStep(
      input.itemVersionId,
      input.attemptId ?? null
    );
    return failed.type === 'cutout_marked_failed'
      ? { type: 'cutout_failed' as const, reason: 'workflow_step_failed' }
      : failed;
  }
}
