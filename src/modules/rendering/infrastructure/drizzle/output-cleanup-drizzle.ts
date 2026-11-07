import { Result } from '@bloodyowl/boxed';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';

import { runRepositoryTransaction } from '@/modules/kernel/infrastructure/db/repository-transaction';
import type { Database } from '@/modules/kernel/infrastructure/db/types';

import {
  checkCleanupEligibility,
  cleanupBlockedReason,
  cleanupError,
  cleanupNow as now,
  enqueueOutputCleanup,
  parseCleanupTarget,
  recordBlockedCleanup,
} from './output-cleanup-records';
import {
  blockedOutstanding,
  createCleanupRepairStore,
} from './output-cleanup-repair-drizzle';
import {
  renderOutputCleanup as table,
  renderOutputCleanupBlocked as blocked,
} from './schema';
import type {
  CleanupClaim,
  OutputCleanupStore,
} from '../../application/ports/output-cleanup';

/** A root runner is mandatory; transaction ownership is never inferred from missing metadata. */
export const createOutputCleanupStore = ({
  db,
}: {
  db: Database;
}): OutputCleanupStore => ({
  ...createCleanupRepairStore(db),
  enqueue: (row) => enqueueOutputCleanup(db, row),
  async cutoff() {
    try {
      const [row] = await db
        .select({
          before: sql<string>`to_char(${now}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        })
        .from(sql`(select 1) as queue_clock`);
      return row
        ? Result.Ok({ type: 'cleanup_cutoff', before: row.before })
        : Result.Error(cleanupError('Cleanup clock unavailable'));
    } catch (cause) {
      return Result.Error(cleanupError(cause));
    }
  },
  async summary() {
    try {
      const rows = await db
        .select({
          code: blocked.reasonCode,
          total: sql<number>`count(*)`.mapWith(Number),
          outstanding:
            sql<number>`count(*) filter (where ${blockedOutstanding})`.mapWith(
              Number
            ),
        })
        .from(blocked)
        .groupBy(blocked.reasonCode);
      return Result.Ok({
        type: 'cleanup_summary',
        blockedOutstanding: rows.reduce(
          (total, row) => total + row.outstanding,
          0
        ),
        outstandingReasons: rows
          .filter((row) => row.outstanding > 0)
          .map((row) => ({ code: row.code, count: row.outstanding })),
        blockedTotal: rows.reduce((total, row) => total + row.total, 0),
        reasons: rows.map((row) => ({ code: row.code, count: row.total })),
      });
    } catch (cause) {
      return Result.Error(cleanupError(cause));
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
              : sql`(${table.nextAttemptAt}, ${table.objectKey}) > (${sql.param(new Date(input.after.nextAttemptAt), table.nextAttemptAt)}::timestamp, ${input.after.objectKey})`
          )
        )
        .orderBy(asc(table.nextAttemptAt), asc(table.objectKey))
        .limit(input.limit);
      const last = rows.at(-1);
      return last
        ? Result.Ok({
            type: 'cleanup_page',
            ids: rows.map((row) => row.id) as [string, ...string[]],
            cursor: {
              nextAttemptAt: last.nextAttemptAt.toISOString(),
              objectKey: last.id,
            },
          })
        : Result.Ok({ type: 'cleanup_empty', ids: [] });
    } catch (cause) {
      return Result.Error(cleanupError(cause));
    }
  },
  async claim(input) {
    try {
      return await runRepositoryTransaction<CleanupClaim>(db, async (tx) => {
        // Match Retry/repair lock order: result first, then queue. Re-read queue under its lock.
        const [candidate] = await tx
          .select()
          .from(table)
          .where(
            and(
              eq(table.objectKey, input.cleanupId),
              isNull(table.completedAt),
              lte(table.nextAttemptAt, now),
              or(isNull(table.leaseUntil), lte(table.leaseUntil, now))
            )
          );
        if (!candidate)
          return Result.Ok({ type: 'cleanup_unavailable' as const });
        const candidateTarget = parseCleanupTarget(candidate);
        const eligible = candidateTarget
          ? await checkCleanupEligibility(tx, candidateTarget)
          : undefined;
        const [row] = await tx
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
        if (
          !row ||
          row.resultId !== candidate.resultId ||
          row.attempt !== candidate.attempt
        )
          return Result.Ok({ type: 'cleanup_unavailable' as const });
        const target = parseCleanupTarget(row);
        if (!target || eligible?.type !== 'cleanup_attempt_eligible') {
          const reasonCode = !target
            ? cleanupBlockedReason
            : eligible?.type === 'cleanup_attempt_active'
              ? 'RENDER_OUTPUT_ATTEMPT_ACTIVE'
              : 'RENDER_OUTPUT_ATTEMPT_INVALID';
          await recordBlockedCleanup(tx, row, reasonCode);
          await tx.delete(table).where(eq(table.objectKey, row.objectKey));
          return Result.Ok({ type: 'cleanup_blocked' as const, reasonCode });
        }
        await tx
          .update(table)
          .set({
            claimToken: input.claimId,
            leaseUntil: sql`${now} + interval '5 minutes'`,
            attempts: sql`${table.attempts}+1`,
          })
          .where(eq(table.objectKey, row.objectKey));
        return Result.Ok({ type: 'cleanup_claimed' as const, target });
      });
    } catch (cause) {
      return Result.Error(cleanupError(cause));
    }
  },
  async settle(input) {
    try {
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
      return Result.Error(cleanupError(cause));
    }
  },
});
