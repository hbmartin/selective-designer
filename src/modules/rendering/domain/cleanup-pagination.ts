import { Result } from '@bloodyowl/boxed';

import type { ApplicationResult } from '@/modules/kernel/application/result';
import { AppError } from '@/modules/kernel/domain/errors/app-error';

/** Defend protocol consumers before they process a malformed or repeated page. */
export function validateCleanupPage(
  page: {
    ids: string[];
    cursor?: { nextAttemptAt: string; objectKey: string };
  },
  after?: { nextAttemptAt: string; objectKey: string }
): ApplicationResult<{ type: 'cleanup_page_valid' }> {
  if (
    page.ids.length &&
    (!page.cursor ||
      page.cursor.objectKey !== page.ids.at(-1) ||
      !Number.isFinite(Date.parse(page.cursor.nextAttemptAt)) ||
      (after &&
        page.cursor.nextAttemptAt === after.nextAttemptAt &&
        page.cursor.objectKey === after.objectKey))
  ) {
    return Result.Error(
      new AppError({
        code: 'RENDER_CLEANUP_CURSOR_INVALID',
        category: 'system',
        status: 500,
        retryable: false,
      })
    );
  }
  return Result.Ok({ type: 'cleanup_page_valid' as const });
}
