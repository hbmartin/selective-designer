import { lazyModule } from '@/modules/kernel/transport/workflow/lazy-module';
import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';
import { runWorkerPage } from '@/modules/kernel/transport/workflow/worker-page';

import type { CleanupCursor } from '../../application/ports/output-cleanup';
import { validateCleanupPage } from '../../domain/cleanup-pagination';

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
  const before = await cutoffStep();
  let after: CleanupCursor | undefined;
  let blockedThisRun = 0;
  let completed = 0;
  let failed = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- snapshot cursor advances between pages.
    const page = await listStep({ before, after });
    unwrapStepResult(validateCleanupPage(page, after));
    if (page.type === 'cleanup_empty') break;
    // oxlint-disable-next-line no-await-in-loop -- deterministic bounded page processing.
    const counts = await runWorkerPage(page.ids, async (id) => {
      const result = await cleanupStep(id);
      if (result.type === 'cleanup_blocked') blockedThisRun++;
      return result.type === 'cleanup_completed';
    });
    completed += counts.completed;
    failed += counts.failed;
    after = page.cursor;
  }
  const summary = await summaryStep();
  return {
    completed,
    failed,
    blockedThisRun,
    blockedTotal: summary.blockedTotal,
  };
}
