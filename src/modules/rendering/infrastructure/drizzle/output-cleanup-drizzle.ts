import { Result } from '@bloodyowl/boxed';
import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { toObjectKey, toRenderResultId } from '@/modules/kernel/domain/ids';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

import { renderOutputCleanup as table } from './schema';
import type { OutputCleanupStore } from '../../application/ports/output-cleanup';
import { validateRenderOutputTarget } from '../../domain/render-output-target';

const errorOf = (cause: unknown) =>
  new AppError({
    code: 'RENDER_OUTPUT_CLEANUP_FAILED',
    category: 'system',
    status: 500,
    cause,
  });
export const createOutputCleanupStore = ({
  db,
}: {
  db: DbLike;
}): OutputCleanupStore => ({
  async enqueue(target, now) {
    const valid = validateRenderOutputTarget(target);
    if (valid.isError()) return Result.Error(valid.getError());
    try {
      await db
        .insert(table)
        .values({ ...target, createdAt: now, nextAttemptAt: now })
        .onConflictDoNothing();
      return Result.Ok({ type: 'cleanup_queued', cleanupId: target.objectKey });
    } catch (cause) {
      return Result.Error(errorOf(cause));
    }
  },
  async list(input) {
    try {
      const rows = await db
        .select({ id: table.objectKey })
        .from(table)
        .where(
          and(
            isNull(table.completedAt),
            lte(table.nextAttemptAt, input.before),
            or(isNull(table.leaseUntil), lte(table.leaseUntil, input.before)),
            input.after === undefined
              ? undefined
              : gt(table.objectKey, input.after)
          )
        )
        .orderBy(asc(table.objectKey))
        .limit(input.limit);
      return Result.Ok({
        type: 'cleanup_listed',
        ids: rows.map((row) => row.id),
      });
    } catch (cause) {
      return Result.Error(errorOf(cause));
    }
  },
  async claim(input) {
    try {
      const [row] = await db
        .update(table)
        .set({
          claimToken: input.claimId,
          leaseUntil: new Date(input.now.getTime() + 5 * 60_000),
          attempts: sql`${table.attempts} + 1`,
        })
        .where(
          and(
            eq(table.objectKey, input.cleanupId),
            isNull(table.completedAt),
            lte(table.nextAttemptAt, input.now),
            or(isNull(table.leaseUntil), lte(table.leaseUntil, input.now))
          )
        )
        .returning();
      if (!row) return Result.Ok({ type: 'cleanup_unavailable' });
      const resultId = toRenderResultId(row.resultId);
      const objectKey = toObjectKey(row.objectKey);
      if (resultId.isError() || objectKey.isError())
        return Result.Error(errorOf('Invalid cleanup target'));
      const target = {
        resultId: resultId.get(),
        objectKey: objectKey.get(),
        attempt: row.attempt,
      };
      const valid = validateRenderOutputTarget(target);
      return valid.isError()
        ? Result.Error(valid.getError())
        : Result.Ok({ type: 'cleanup_claimed', target });
    } catch (cause) {
      return Result.Error(errorOf(cause));
    }
  },
  async settle(input) {
    try {
      const rows = await db
        .update(table)
        .set({
          claimToken: null,
          leaseUntil: null,
          completedAt: input.outcome === 'retry' ? null : input.now,
          outcome: input.outcome === 'retry' ? null : input.outcome,
          nextAttemptAt: new Date(input.now.getTime() + 5_000),
          lastErrorCode: input.code ?? null,
        })
        .where(
          and(
            eq(table.objectKey, input.cleanupId),
            eq(table.claimToken, input.claimId),
            isNull(table.completedAt)
          )
        )
        .returning({ id: table.objectKey });
      return Result.Ok({
        type: rows.length ? 'cleanup_settled' : 'cleanup_superseded',
      });
    } catch (cause) {
      return Result.Error(errorOf(cause));
    }
  },
});
