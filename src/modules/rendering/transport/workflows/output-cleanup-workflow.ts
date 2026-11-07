import { Result } from '@bloodyowl/boxed';

import { isAppError } from '@/modules/kernel/domain/errors/app-error';
import { lazyModule } from '@/modules/kernel/transport/workflow/lazy-module';
import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';

import { runRenderCleanupSweep } from '../cleanup-sweep';
import type { CleanupCursor } from '../../application/ports/output-cleanup';

const loadModule = lazyModule(
  () => import('@/composition/render-output-cleanup')
);
const cleanup = async () => (await loadModule()).getRenderOutputCleanup();

async function listStep(input: { before: string; after?: CleanupCursor }) {
  'use step';
  return unwrapStepResult(await (await cleanup()).list(input));
}
async function cleanupStep(cleanupId: string) {
  'use step';
  return unwrapStepResult(await (await cleanup()).process(cleanupId));
}
async function cutoffStep() {
  'use step';
  return unwrapStepResult(await (await cleanup()).cutoff()).before;
}
async function summaryStep() {
  'use step';
  return unwrapStepResult(await (await cleanup()).summary());
}
export async function renderOutputCleanupWorkflow() {
  'use workflow';
  try {
    return await runRenderCleanupSweep(
      {
        cutoff: cutoffStep,
        list: listStep,
        process: cleanupStep,
        summary: summaryStep,
      },
      5
    );
  } catch (error) {
    if (isAppError(error)) return unwrapStepResult(Result.Error(error));
    throw error;
  }
}
