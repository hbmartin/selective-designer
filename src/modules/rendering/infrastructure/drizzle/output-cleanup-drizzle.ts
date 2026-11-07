import { Result } from '@bloodyowl/boxed';
import { and, asc, count, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { toObjectKey, toRenderResultId } from '@/modules/kernel/domain/ids';
import { runRepositoryTransaction } from '@/modules/kernel/infrastructure/db/repository-transaction';
import {
  type DbLike,
  isRootDatabase,
} from '@/modules/kernel/infrastructure/db/types';

import {
  renderOutputCleanup as table,
  renderOutputCleanupBlocked as blocked,
} from './schema';
import type { OutputCleanupStore } from '../../application/ports/output-cleanup';
import { validateRenderOutputTarget } from '../../domain/render-output-target';

const now = sql`(statement_timestamp() at time zone 'UTC')`;
const errorOf = (cause: unknown) =>
  new AppError({
    code: 'RENDER_OUTPUT_CLEANUP_FAILED',
    category: 'system',
    status: 500,
    cause,
  });
const reasonCode = 'RENDER_OUTPUT_TARGET_INVALID';
const parseTarget = (row: {
  resultId: string;
  attempt: number;
  objectKey: unknown;
}) => {
  const resultId = toRenderResultId(row.resultId);
  const objectKey =
    typeof row.objectKey === 'string' ? toObjectKey(row.objectKey) : undefined;
  if (resultId.isError() || !objectKey || objectKey.isError()) return undefined;
  const target = {
    resultId: resultId.get(),
    attempt: row.attempt,
    objectKey: objectKey.get(),
  };
  // Do not normalize unsafe input into an allowed key.
  return target.objectKey === row.objectKey &&
    validateRenderOutputTarget(target).isOk()
    ? target
    : undefined;
};
const recordBlocked = async (
  db: DbLike,
  row: { resultId: string; attempt: number; objectKey: unknown }
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
  await db
    .insert(blocked)
    .values({
      fingerprint,
      resultId: /^[A-Za-z0-9_-]+$/u.test(row.resultId) ? row.resultId : null,
      attempt:
        Number.isSafeInteger(row.attempt) &&
        row.attempt > 0 &&
        row.attempt <= 2147483647
          ? row.attempt
          : null,
      reasonCode,
      createdAt: now,
    })
    .onConflictDoNothing();
};
export const createOutputCleanupStore = ({
  db,
}: {
  db: DbLike;
}): OutputCleanupStore => {
  const store: OutputCleanupStore = {
    async enqueue(row) {
      try {
        const target = parseTarget(row);
        if (!target) {
          await recordBlocked(db, row);
          return Result.Ok({ type: 'cleanup_blocked', reasonCode });
        }
        await db
          .insert(table)
          .values({ ...target, createdAt: now, nextAttemptAt: now })
          .onConflictDoNothing();
        return Result.Ok({
          type: 'cleanup_queued',
          cleanupId: target.objectKey,
        });
      } catch (cause) {
        return Result.Error(errorOf(cause));
      }
    },
    async cutoff() {
      try {
        const [row] = await db
          .select({
            before: sql<string>`to_char(${now}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
          })
          .from(sql`(select 1) as queue_clock`);
        if (!row) return Result.Error(errorOf('Cleanup clock unavailable'));
        return Result.Ok({ type: 'cleanup_cutoff', before: row.before });
      } catch (cause) {
        return Result.Error(errorOf(cause));
      }
    },
    async summary() {
      try {
        const rows = await db
          .select({ code: blocked.reasonCode, count: count() })
          .from(blocked)
          .groupBy(blocked.reasonCode);
        return Result.Ok({
          type: 'cleanup_summary',
          blocked: rows.reduce((total, row) => total + row.count, 0),
          reasons: rows,
        });
      } catch (cause) {
        return Result.Error(errorOf(cause));
      }
    },
    async list(input) {
      try {
        const rows = await db
          .select({ id: table.objectKey, nextAttemptAt: table.nextAttemptAt })
          .from(table)
          .where(
            and(
              isNull(table.completedAt),
              lte(table.nextAttemptAt, new Date(input.before)),
              or(isNull(table.leaseUntil), lte(table.leaseUntil, now)),
              input.after === undefined
                ? undefined
                : sql`(${table.nextAttemptAt}, ${table.objectKey}) > (${new Date(input.after.nextAttemptAt)}::timestamp, ${input.after.objectKey})`
            )
          )
          .orderBy(asc(table.nextAttemptAt), asc(table.objectKey))
          .limit(input.limit);
        const last = rows.at(-1);
        return Result.Ok({
          type: 'cleanup_listed',
          ids: rows.map((row) => row.id),
          ...(last
            ? {
                cursor: {
                  nextAttemptAt: last.nextAttemptAt.toISOString(),
                  objectKey: last.id,
                },
              }
            : {}),
        });
      } catch (cause) {
        return Result.Error(errorOf(cause));
      }
    },
    async claim(input) {
      try {
        if (isRootDatabase(db))
          return await runRepositoryTransaction(db, (tx) =>
            createOutputCleanupStore({ db: tx }).claim(input)
          );
        const [row] = await db
          .select()
          .from(table)
          .where(
            and(
              eq(table.objectKey, input.cleanupId),
              isNull(table.completedAt),
              lte(table.nextAttemptAt, now),
              or(isNull(table.leaseUntil), lte(table.leaseUntil, now))
            )
          )
          .for('update', { skipLocked: true });
        if (!row) return Result.Ok({ type: 'cleanup_unavailable' });
        const target = parseTarget(row);
        if (!target) {
          await recordBlocked(db, row);
          await db.delete(table).where(eq(table.objectKey, row.objectKey));
          return Result.Ok({ type: 'cleanup_blocked', reasonCode });
        }
        await db
          .update(table)
          .set({
            claimToken: input.claimId,
            leaseUntil: sql`${now} + interval '5 minutes'`,
            attempts: sql`${table.attempts} + 1`,
          })
          .where(eq(table.objectKey, row.objectKey));
        return Result.Ok({ type: 'cleanup_claimed', target });
      } catch (cause) {
        return Result.Error(errorOf(cause));
      }
    },
    async settle(input) {
      try {
        if (input.outcome === 'blocked') {
          if (isRootDatabase(db))
            return await runRepositoryTransaction(db, (tx) =>
              createOutputCleanupStore({ db: tx }).settle(input)
            );
          const [row] = await db
            .select()
            .from(table)
            .where(
              and(
                eq(table.objectKey, input.cleanupId),
                eq(table.claimToken, input.claimId),
                isNull(table.completedAt)
              )
            )
            .for('update');
          if (!row) return Result.Ok({ type: 'cleanup_superseded' });
          await recordBlocked(db, row);
          await db
            .delete(table)
            .where(
              and(
                eq(table.objectKey, input.cleanupId),
                eq(table.claimToken, input.claimId)
              )
            );
          return Result.Ok({ type: 'cleanup_settled' });
        }
        const rows = await db
          .update(table)
          .set({
            claimToken: null,
            leaseUntil: null,
            completedAt: input.outcome === 'retry' ? null : now,
            outcome: input.outcome === 'retry' ? null : input.outcome,
            nextAttemptAt: sql`${now} + interval '5 seconds'`,
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
  };
  return store;
};
