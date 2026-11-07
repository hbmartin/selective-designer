import { Result } from '@bloodyowl/boxed';
import { and, desc, eq, getTableColumns, gt, lt, or, sql } from 'drizzle-orm';

import { runRepositoryTransaction } from '@/modules/kernel/infrastructure/db/repository-transaction';
import type { Database } from '@/modules/kernel/infrastructure/db/types';

import {
  checkCleanupEligibility,
  cleanupError,
  cleanupNow,
  parseCleanupTarget,
} from './output-cleanup-records';
import {
  renderOutputCleanup as queue,
  renderOutputCleanupBlocked as blocked,
  renderOutputCleanupRecovery as recovery,
} from './schema';
import type {
  CleanupAcknowledgmentInput,
  CleanupAcknowledgmentOutcome,
  CleanupRecoveryEvent,
  CleanupRepairInput,
  CleanupRepairOutcome,
  OutputCleanupStore,
} from '../../application/ports/output-cleanup';
import { safeBlockedObjectKey } from '../../domain/render-output-target';

export const blockedOutstanding = sql<boolean>`not exists(select 1 from ${recovery} where ${recovery.fingerprint} = ${blocked.fingerprint})`;
const intervention = sql<
  'outstanding' | 'acknowledged' | 'handed_off'
>`case when ${blockedOutstanding} then 'outstanding' when exists(select 1 from ${recovery} where ${recovery.fingerprint} = ${blocked.fingerprint} and ${recovery.outcome} = 'cleanup_acknowledged') then 'acknowledged' else 'handed_off' end`;
const publicBlocked = {
  intervention,
  fingerprint: blocked.fingerprint,
  resultId: blocked.resultId,
  attempt: blocked.attempt,
  reasonCode: blocked.reasonCode,
  createdAt: blocked.createdAt,
};
const replay = (
  row: typeof recovery.$inferSelect,
  input: CleanupRepairInput
): CleanupRepairOutcome =>
  row.fingerprint === input.fingerprint &&
  row.resultId === input.resultId &&
  row.attempt === input.attempt &&
  row.outcome !== 'cleanup_acknowledged'
    ? { type: row.outcome, requestId: row.requestId }
    : { type: 'cleanup_repair_conflict' };
export function createCleanupRepairStore(
  db: Database
): Pick<OutputCleanupStore, 'blocked' | 'inspect' | 'requeue' | 'acknowledge'> {
  return {
    async blocked(input) {
      const { limit, after, outstanding } =
        typeof input === 'number'
          ? { limit: input, after: undefined, outstanding: false }
          : input;
      try {
        const rows = await db
          .select(publicBlocked)
          .from(blocked)
          .where(
            and(
              outstanding ? blockedOutstanding : undefined,
              after
                ? or(
                    lt(blocked.createdAt, new Date(after.createdAt)),
                    and(
                      eq(blocked.createdAt, new Date(after.createdAt)),
                      gt(blocked.fingerprint, after.fingerprint)
                    )
                  )
                : undefined
            )
          )
          .orderBy(
            sql`${blocked.createdAt} desc nulls last`,
            blocked.fingerprint
          )
          .limit(limit + 1);
        const records = rows.slice(0, limit);
        const last = records.at(-1);
        return Result.Ok({
          type: 'blocked_cleanup_list',
          records,
          pagination:
            rows.length > limit && last
              ? {
                  type: 'blocked_more',
                  cursor: {
                    createdAt: last.createdAt.toISOString(),
                    fingerprint: last.fingerprint,
                  },
                }
              : { type: 'blocked_end' },
        });
      } catch (cause) {
        return Result.Error(cleanupError(cause));
      }
    },
    async inspect(fingerprint) {
      try {
        const [row] = await db
          .select({ ...getTableColumns(blocked), intervention })
          .from(blocked)
          .where(eq(blocked.fingerprint, fingerprint));
        if (!row) return Result.Ok({ type: 'blocked_not_found' });
        const recoveries = await db
          .select({
            requestId: recovery.requestId,
            reasonCode: recovery.reasonCode,
            resultId: recovery.resultId,
            attempt: recovery.attempt,
            createdAt: recovery.createdAt,
            outcome: recovery.outcome,
            previousOutcome: recovery.previousOutcome,
            previousCompletedAt: recovery.previousCompletedAt,
          })
          .from(recovery)
          .where(eq(recovery.fingerprint, fingerprint))
          .orderBy(desc(recovery.createdAt));
        // Revalidate persisted locators before privileged disclosure, including corrupted rows.
        return Result.Ok({
          type: 'blocked_cleanup_found',
          record: {
            intervention: row.intervention,
            fingerprint: row.fingerprint,
            resultId: row.resultId,
            attempt: row.attempt,
            createdAt: row.createdAt,
            reasonCode: row.reasonCode,
          },
          locator: safeBlockedObjectKey(row.safeObjectKey),
          recoveries: recoveries.map((event): CleanupRecoveryEvent => {
            if (event.outcome === 'cleanup_acknowledged')
              return {
                requestId: event.requestId,
                createdAt: event.createdAt,
                outcome: event.outcome,
                reasonCode: 'locator_unavailable_retained',
              };
            if (event.resultId === null || event.attempt === null)
              throw cleanupError('Recovery audit invalid');
            return {
              requestId: event.requestId,
              createdAt: event.createdAt,
              outcome: event.outcome,
              resultId: event.resultId,
              attempt: event.attempt,
              previousOutcome: event.previousOutcome,
              previousCompletedAt: event.previousCompletedAt,
            };
          }),
        });
      } catch (cause) {
        return Result.Error(cleanupError(cause));
      }
    },
    async acknowledge(input: CleanupAcknowledgmentInput) {
      const replayAcknowledgment = (
        event: typeof recovery.$inferSelect
      ): CleanupAcknowledgmentOutcome =>
        event.fingerprint === input.fingerprint &&
        event.outcome === 'cleanup_acknowledged'
          ? { type: 'cleanup_acknowledged', requestId: input.requestId }
          : { type: 'cleanup_repair_conflict' };
      try {
        return await runRepositoryTransaction<CleanupAcknowledgmentOutcome>(
          db,
          async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${input.requestId}, 0))`
            );
            const [event] = await tx
              .select()
              .from(recovery)
              .where(eq(recovery.requestId, input.requestId));
            if (event) return Result.Ok(replayAcknowledgment(event));
            const [evidence] = await tx
              .select()
              .from(blocked)
              .where(eq(blocked.fingerprint, input.fingerprint));
            if (!evidence) return Result.Ok({ type: 'blocked_not_found' });
            if (safeBlockedObjectKey(evidence.safeObjectKey))
              return Result.Ok({ type: 'locator_available' });
            await tx.insert(recovery).values({
              requestId: input.requestId,
              fingerprint: input.fingerprint,
              outcome: 'cleanup_acknowledged',
              reasonCode: 'locator_unavailable_retained',
              createdAt: cleanupNow,
            });
            return Result.Ok({
              type: 'cleanup_acknowledged',
              requestId: input.requestId,
            });
          }
        );
      } catch (cause) {
        try {
          const [event] = await db
            .select()
            .from(recovery)
            .where(eq(recovery.requestId, input.requestId));
          if (event) return Result.Ok(replayAcknowledgment(event));
        } catch (reconciliationCause) {
          return Result.Error(cleanupError(cause, reconciliationCause));
        }
        return Result.Error(cleanupError(cause));
      }
    },
    async requeue(input) {
      try {
        return await runRepositoryTransaction<CleanupRepairOutcome>(
          db,
          async (tx) => {
            // Serialize a replay identity independently of the target. No unsafe input enters diagnostics.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${input.requestId}, 0))`
            );
            const [event] = await tx
              .select()
              .from(recovery)
              .where(eq(recovery.requestId, input.requestId));
            if (event) return Result.Ok(replay(event, input));
            // Blocked evidence is immutable; do not lock it before a queue row (quarantine locks queue first).
            const [evidence] = await tx
              .select()
              .from(blocked)
              .where(eq(blocked.fingerprint, input.fingerprint));
            if (!evidence)
              return Result.Ok({ type: 'blocked_not_found' as const });
            const key = safeBlockedObjectKey(evidence.safeObjectKey);
            if (!key)
              return Result.Ok({ type: 'locator_unavailable' as const });
            const target = parseCleanupTarget({ ...input, objectKey: key });
            if (!target)
              return Result.Ok({ type: 'cleanup_target_mismatch' as const });
            const eligible = await checkCleanupEligibility(tx, target);
            if (eligible.type !== 'cleanup_attempt_eligible')
              return Result.Ok(eligible);
            const inserted = await tx
              .insert(queue)
              .values({
                ...target,
                createdAt: cleanupNow,
                nextAttemptAt: cleanupNow,
              })
              .onConflictDoNothing()
              .returning({ key: queue.objectKey });
            const [previous] = await tx
              .select()
              .from(queue)
              .where(eq(queue.objectKey, key))
              .for('update');
            if (!previous) throw cleanupError('Cleanup queue unavailable');
            if (
              !previous.completedAt &&
              (previous.resultId !== target.resultId ||
                previous.attempt !== target.attempt)
            )
              return Result.Ok({ type: 'cleanup_repair_conflict' as const });
            const outcome =
              inserted.length || previous.outcome === 'output_retained'
                ? ('cleanup_requeued' as const)
                : previous.completedAt
                  ? ('cleanup_already_completed' as const)
                  : ('cleanup_already_pending' as const);
            if (
              previous.completedAt &&
              previous.outcome === 'output_retained'
            ) {
              await tx
                .update(queue)
                .set({
                  ...target,
                  completedAt: null,
                  outcome: null,
                  lastErrorCode: null,
                  claimToken: null,
                  leaseUntil: null,
                  nextAttemptAt: cleanupNow,
                })
                .where(eq(queue.objectKey, key));
            }
            await tx.insert(recovery).values({
              requestId: input.requestId,
              fingerprint: input.fingerprint,
              ...target,
              outcome,
              previousOutcome: previous.outcome,
              previousCompletedAt: previous.completedAt,
              createdAt: cleanupNow,
            });
            return Result.Ok({ type: outcome, requestId: input.requestId });
          }
        );
      } catch (cause) {
        // A committed event proves the atomic queue transition; otherwise keep the original error.
        try {
          const [event] = await db
            .select()
            .from(recovery)
            .where(eq(recovery.requestId, input.requestId));
          if (event) return Result.Ok(replay(event, input));
        } catch (reconciliationCause) {
          return Result.Error(cleanupError(cause, reconciliationCause));
        }
        return Result.Error(cleanupError(cause));
      }
    },
  };
}
