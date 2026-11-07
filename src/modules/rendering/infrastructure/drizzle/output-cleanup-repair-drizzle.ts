import { Result } from '@bloodyowl/boxed';
import { desc, eq, sql } from 'drizzle-orm';

import { runRepositoryTransaction } from '@/modules/kernel/infrastructure/db/repository-transaction';
import type { Database } from '@/modules/kernel/infrastructure/db/types';

import {
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
  CleanupRepairInput,
  CleanupRepairOutcome,
  OutputCleanupStore,
} from '../../application/ports/output-cleanup';
import { safeBlockedObjectKey } from '../../domain/render-output-target';

const publicBlocked = {
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
  row.attempt === input.attempt
    ? { type: row.outcome, requestId: row.requestId }
    : { type: 'cleanup_repair_conflict' };
export function createCleanupRepairStore(
  db: Database
): Pick<OutputCleanupStore, 'blocked' | 'inspect' | 'requeue'> {
  return {
    async blocked(limit) {
      try {
        const records = await db
          .select(publicBlocked)
          .from(blocked)
          .orderBy(desc(blocked.createdAt), blocked.fingerprint)
          .limit(limit);
        return Result.Ok({ type: 'blocked_cleanup_list', records });
      } catch (cause) {
        return Result.Error(cleanupError(cause));
      }
    },
    async inspect(fingerprint) {
      try {
        const [row] = await db
          .select()
          .from(blocked)
          .where(eq(blocked.fingerprint, fingerprint));
        if (!row) return Result.Ok({ type: 'blocked_not_found' });
        const recoveries = await db
          .select({
            requestId: recovery.requestId,
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
            fingerprint: row.fingerprint,
            resultId: row.resultId,
            attempt: row.attempt,
            createdAt: row.createdAt,
            reasonCode: row.reasonCode,
          },
          locator: safeBlockedObjectKey(row.safeObjectKey),
          recoveries,
        });
      } catch (cause) {
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
