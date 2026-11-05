import { FatalError } from 'workflow';

import { toItemVersionId } from '@/modules/kernel/domain/ids';
import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';

const versionIdOrFail = (value: string) => {
  const id = toItemVersionId(value);
  if (id.isError()) throw new FatalError(`Invalid item version id: ${value}`);
  return id.get();
};

/** The step loads worker-only composition without request dependencies. */
async function removeBackgroundStep(itemVersionId: string, attemptId: string) {
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
  attemptId: string,
  failureCode: string
) {
  'use step';
  const { getMoodboardPipelineUseCases } =
    await import('@/composition/moodboard-pipeline');
  return unwrapStepResult(
    await getMoodboardPipelineUseCases().markCutoutFailed({
      versionId: versionIdOrFail(itemVersionId),
      attemptId,
      failureCode,
    })
  );
}

export async function removeBackgroundWorkflow(input: {
  itemVersionId: string;
  attemptId: string;
}) {
  'use workflow';
  try {
    return await removeBackgroundStep(input.itemVersionId, input.attemptId);
  } catch (error) {
    // AppError step failures carry a stable code. Avoid persisting provider messages.
    const failureCode =
      error instanceof Error
        ? /^([A-Z][A-Z0-9_]{2,63}):/u.exec(error.message)?.[1]
        : undefined;
    const code = failureCode ?? 'WORKFLOW_STEP_FAILED';
    try {
      const failed = await markCutoutFailedStep(
        input.itemVersionId,
        input.attemptId,
        code
      );
      if (failed.type === 'cutout_skipped') return failed;
    } catch {
      // Preserve the original diagnostic if the failure state could not be saved.
    }
    throw new FatalError(`${code}: Background removal workflow failed`);
  }
}
