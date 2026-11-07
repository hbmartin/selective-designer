import { runWorkerPage } from '@/modules/kernel/transport/workflow/worker-page';

import type {
  CleanupCursor,
  CleanupPage,
} from '../application/ports/output-cleanup';
import {
  cleanupCursorIdentity,
  validateCleanupPage,
} from '../domain/cleanup-pagination';

/** Deterministic orchestration: callers retain ownership of I/O and durable steps. */
export async function runRenderCleanupSweep(
  operations: {
    cutoff(): Promise<string>;
    list(input: {
      before: string;
      after?: CleanupCursor;
    }): Promise<CleanupPage>;
    process(id: string): Promise<{ type: string }>;
    summary(): Promise<{
      blockedTotal: number;
      blockedOutstanding: number;
      reasons: { code: string; count: number }[];
      outstandingReasons: { code: string; count: number }[];
    }>;
  },
  concurrency: 1 | 5
) {
  const before = await operations.cutoff();
  const seen = new Set<string>();
  let after: CleanupCursor | undefined;
  let blockedThisRun = 0;
  let completed = 0;
  let failed = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- deterministic snapshot pagination.
    const page = await operations.list({ before, after });
    const valid = validateCleanupPage(page, after, seen);
    if (valid.isError()) throw valid.getError();
    if (page.type === 'cleanup_empty') break;
    seen.add(cleanupCursorIdentity(page.cursor));
    // oxlint-disable-next-line no-await-in-loop -- finish each bounded page before advancing.
    const counts = await runWorkerPage(
      page.ids,
      async (id) => {
        const result = await operations.process(id);
        if (result.type === 'cleanup_blocked') blockedThisRun++;
        return result.type === 'cleanup_completed';
      },
      concurrency
    );
    completed += counts.completed;
    failed += counts.failed;
    after = page.cursor;
  }
  const summary = await operations.summary();
  return {
    completed,
    failed,
    blockedThisRun,
    blockedTotal: summary.blockedTotal,
    blockedOutstanding: summary.blockedOutstanding,
    blockedReasons: summary.reasons,
    outstandingReasons: summary.outstandingReasons,
  };
}
