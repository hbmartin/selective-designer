import { FatalError } from 'workflow';

import { toItemVersionId } from '@/modules/kernel/domain/ids';
import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';

/**
 * Durable background removal for one item version. The step loads the
 * pipeline use cases lazily so the workflow bundle stays free of app wiring.
 */
async function removeBackgroundStep(itemVersionId: string) {
  'use step';
  const id = toItemVersionId(itemVersionId);
  if (id.isError())
    throw new FatalError(`Invalid item version id: ${itemVersionId}`);
  const { getMoodboardPipelineUseCases } =
    await import('@/composition/moodboard-pipeline');
  return unwrapStepResult(
    await getMoodboardPipelineUseCases().removeBackground(id.get())
  );
}

export async function removeBackgroundWorkflow(input: {
  itemVersionId: string;
}) {
  'use workflow';
  return removeBackgroundStep(input.itemVersionId);
}
