import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';
import { runWorkerPage } from '@/modules/kernel/transport/workflow/worker-page';

import type { CleanupCursor } from '../../application/ports/output-cleanup';

type CleanupModule = typeof import('@/composition/render-output-cleanup');
let cleanupModule: Promise<CleanupModule> | undefined;
const cleanup = async () => {
  cleanupModule ??= import('@/composition/render-output-cleanup').catch(
    (error: unknown) => {
      cleanupModule = undefined;
      throw error;
    }
  );
  return (await cleanupModule).getRenderOutputCleanup();
};

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
  let completed = 0;
  let failed = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- snapshot cursor advances between pages.
    const page = await listStep({ before, after });
    if (!page.ids.length) break;
    // oxlint-disable-next-line no-await-in-loop -- deterministic bounded page processing.
    const counts = await runWorkerPage(
      page.ids,
      async (id) => (await cleanupStep(id)).type === 'cleanup_completed'
    );
    completed += counts.completed;
    failed += counts.failed;
    after = page.cursor;
  }
  const summary = await summaryStep();
  return { completed, failed, blocked: summary.blocked };
}
