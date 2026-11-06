import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';

async function listStep(input: { before: string; after?: string }) {
  'use step';
  const { getRenderOutputCleanup } =
    await import('@/composition/render-output-cleanup');
  return unwrapStepResult(await getRenderOutputCleanup().list(input));
}
async function cleanupStep(cleanupId: string) {
  'use step';
  const { getRenderOutputCleanup } =
    await import('@/composition/render-output-cleanup');
  return unwrapStepResult(await getRenderOutputCleanup().process(cleanupId));
}
async function cutoffStep() {
  'use step';
  const { getRenderOutputCleanup } =
    await import('@/composition/render-output-cleanup');
  return getRenderOutputCleanup().startedAt();
}
export async function renderOutputCleanupWorkflow() {
  'use workflow';
  const before = await cutoffStep();
  let after: string | undefined;
  let completed = 0;
  let failed = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- snapshot cursor advances between pages.
    const page = await listStep({ before, after });
    if (!page.ids.length) break;
    let next = 0;
    const worker = async () => {
      while (next < page.ids.length) {
        const id = page.ids[next++];
        if (id === undefined) break;
        try {
          // oxlint-disable-next-line no-await-in-loop -- each slot continues independently of slower slots.
          const result = await cleanupStep(id);
          if (result.type === 'cleanup_completed') completed++;
        } catch {
          failed++;
        }
      }
    };
    // oxlint-disable-next-line no-await-in-loop -- five durable worker slots per page.
    await Promise.all(
      Array.from({ length: Math.min(5, page.ids.length) }, worker)
    );
    after = page.ids.at(-1);
  }
  return { completed, failed };
}
