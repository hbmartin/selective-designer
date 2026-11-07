import { Result } from '@bloodyowl/boxed';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { safeErrorDiagnostics } from '@/modules/kernel/domain/errors/safe-error-diagnostics';
import { toObjectKey, toRenderResultId } from '@/modules/kernel/domain/ids';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

import {
  renderOutputCleanup as table,
  renderOutputCleanupBlocked as blocked,
} from './schema';
import type { OutputCleanupStore } from '../../application/ports/output-cleanup';
import {
  safeBlockedObjectKey,
  safeRenderIdentity,
  validateRenderOutputTarget,
} from '../../domain/render-output-target';

export const cleanupNow = sql`(statement_timestamp() at time zone 'UTC')`;
export const cleanupError = (cause: unknown, reconciliationCause?: unknown) =>
  new AppError({
    code: 'RENDER_OUTPUT_CLEANUP_FAILED',
    category: 'system',
    status: 500,
    cause,
    ...(reconciliationCause === undefined
      ? {}
      : {
          details: {
            reconciliation: safeErrorDiagnostics(reconciliationCause),
          },
        }),
  });
export const cleanupBlockedReason = 'RENDER_OUTPUT_TARGET_INVALID';
export type CleanupEvidence = {
  resultId: string;
  attempt: number;
  objectKey: unknown;
};
export const parseCleanupTarget = (row: CleanupEvidence) => {
  const resultId = toRenderResultId(row.resultId);
  const objectKey =
    typeof row.objectKey === 'string' ? toObjectKey(row.objectKey) : undefined;
  if (resultId.isError() || !objectKey || objectKey.isError()) return undefined;
  const target = {
    resultId: resultId.get(),
    attempt: row.attempt,
    objectKey: objectKey.get(),
  };
  return target.resultId === row.resultId &&
    target.objectKey === row.objectKey &&
    validateRenderOutputTarget(target).isOk()
    ? target
    : undefined;
};
export const recordBlockedCleanup = async (
  db: DbLike,
  row: CleanupEvidence
) => {
  const evidence = [
    row.resultId,
    row.attempt,
    typeof row.objectKey,
    row.objectKey === undefined ? 'missing' : row.objectKey,
  ];
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(evidence, (_key, value: unknown) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0
              )
            )
          : value
      )
    )
    .digest('hex');
  const identity = safeRenderIdentity(row);
  await db
    .insert(blocked)
    .values({
      fingerprint,
      resultId: identity.resultId ?? null,
      attempt: identity.attempt ?? null,
      safeObjectKey: safeBlockedObjectKey(row.objectKey),
      reasonCode: cleanupBlockedReason,
      createdAt: cleanupNow,
    })
    .onConflictDoNothing();
};
/** One insert; callers owning larger writes supply their existing transaction. */
export const enqueueOutputCleanup = async (
  db: DbLike,
  row: Parameters<OutputCleanupStore['enqueue']>[0]
): ReturnType<OutputCleanupStore['enqueue']> => {
  try {
    const target = parseCleanupTarget(row);
    if (!target) {
      await recordBlockedCleanup(db, row);
      return Result.Ok({
        type: 'cleanup_blocked',
        reasonCode: cleanupBlockedReason,
      });
    }
    await db
      .insert(table)
      .values({ ...target, createdAt: cleanupNow, nextAttemptAt: cleanupNow })
      .onConflictDoNothing();
    return Result.Ok({ type: 'cleanup_queued', cleanupId: target.objectKey });
  } catch (cause) {
    return Result.Error(cleanupError(cause));
  }
};
