import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';

/** Defend protocol consumers before they process a malformed or repeated page. */
export function validateCleanupPage(
  page: {
    ids: string[];
    cursor?: { nextAttemptAt: string; objectKey: string };
  },
  after?: { nextAttemptAt: string; objectKey: string },
  seen: ReadonlySet<string> = new Set()
): BoxedResult<{ type: 'cleanup_page_valid' }, AppError> {
  if (
    page.ids.length &&
    (!page.cursor ||
      page.cursor.objectKey !== page.ids.at(-1) ||
      !Number.isFinite(Date.parse(page.cursor.nextAttemptAt)) ||
      seen.has(cleanupCursorIdentity(page.cursor)) ||
      (after &&
        Date.parse(page.cursor.nextAttemptAt) <
          Date.parse(after.nextAttemptAt)) ||
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

export const cleanupCursorIdentity = (cursor: {
  nextAttemptAt: string;
  objectKey: string;
}) => JSON.stringify([Date.parse(cursor.nextAttemptAt), cursor.objectKey]);
