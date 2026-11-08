import { Result } from '@bloodyowl/boxed';
import { and, asc, eq, getTableColumns, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { runRepositoryTransaction } from '@/modules/kernel/infrastructure/db/repository-transaction';
import type {
  Database,
  DbLike,
} from '@/modules/kernel/infrastructure/db/types';

import { cleanupError, cleanupNow } from './output-cleanup-records';
import {
  renderOutputCleanupAcknowledgmentRequest as aliases,
  renderOutputCleanupBlocked as blocked,
  renderOutputCleanupRecovery as recovery,
} from './schema';
import type {
  CleanupAcknowledgmentInput,
  CleanupAcknowledgmentOutcome,
  OutputCleanupStore,
} from '../../application/ports/output-cleanup';
import { safeBlockedObjectKey } from '../../domain/render-output-target';

/** Request identities are shared across actions; fingerprint serialization coalesces acknowledgments. */
export async function lockCleanupRecoveryRequest(
  db: DbLike,
  input: CleanupAcknowledgmentInput
) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.requestId}, 0))`
  );
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.fingerprint}, 1))`
  );
}

type AcknowledgmentColumns = Pick<
  ReturnType<typeof alias<typeof recovery, string>>,
  'fingerprint' | 'outcome' | 'createdAt' | 'requestId'
>;

export const acknowledgmentSelection = (
  table: AcknowledgmentColumns,
  fingerprint: string | AcknowledgmentColumns['fingerprint']
) => ({
  where: and(
    eq(table.fingerprint, fingerprint),
    eq(table.outcome, 'cleanup_acknowledged')
  ),
  orderBy: [asc(table.createdAt), asc(table.requestId)],
});

const canonicalAcknowledgment = async (db: DbLike, fingerprint: string) => {
  const selection = acknowledgmentSelection(recovery, fingerprint);
  const [event] = await db
    .select()
    .from(recovery)
    .where(selection.where)
    .orderBy(...selection.orderBy)
    .limit(1);
  return event;
};

export async function findCleanupRecoveryRequest(
  db: DbLike,
  requestId: string
) {
  const [event] = await db
    .select()
    .from(recovery)
    .where(eq(recovery.requestId, requestId));
  if (event)
    return event.outcome === 'cleanup_acknowledged'
      ? canonicalAcknowledgment(db, event.fingerprint)
      : event;
  const canonical = alias(recovery, 'canonical_acknowledgment');
  const earliest = alias(recovery, 'earliest_acknowledgment');
  const selection = acknowledgmentSelection(earliest, canonical.fingerprint);
  const [found] = await db
    .select({
      targetId: canonical.requestId,
      acknowledgment: getTableColumns(earliest),
    })
    .from(aliases)
    .leftJoin(
      canonical,
      and(
        eq(canonical.requestId, aliases.canonicalRequestId),
        eq(canonical.fingerprint, aliases.fingerprint),
        eq(canonical.outcome, 'cleanup_acknowledged')
      )
    )
    .leftJoin(earliest, selection.where)
    .where(eq(aliases.requestId, requestId))
    .orderBy(...selection.orderBy)
    .limit(1);
  if (!found) return undefined;
  if (!found.targetId || !found.acknowledgment)
    throw cleanupError('Acknowledgment replay invalid');
  return found.acknowledgment;
}

export function createCleanupAcknowledgmentStore(
  db: Database
): OutputCleanupStore['acknowledge'] {
  return async (input) => {
    const replay = (
      event: typeof recovery.$inferSelect
    ): CleanupAcknowledgmentOutcome =>
      event.fingerprint === input.fingerprint &&
      event.outcome === 'cleanup_acknowledged'
        ? {
            type: 'cleanup_acknowledged',
            requestId: input.requestId,
            canonicalRequestId: event.requestId,
          }
        : { type: 'cleanup_repair_conflict' };
    try {
      return await runRepositoryTransaction<CleanupAcknowledgmentOutcome>(
        db,
        async (tx) => {
          await lockCleanupRecoveryRequest(tx, input);
          const existingRequest = await findCleanupRecoveryRequest(
            tx,
            input.requestId
          );
          if (existingRequest) return Result.Ok(replay(existingRequest));
          const [evidence] = await tx
            .select()
            .from(blocked)
            .where(eq(blocked.fingerprint, input.fingerprint));
          if (!evidence) return Result.Ok({ type: 'blocked_not_found' });
          const [handoff] = await tx
            .select({ id: recovery.requestId })
            .from(recovery)
            .where(
              and(
                eq(recovery.fingerprint, input.fingerprint),
                ne(recovery.outcome, 'cleanup_acknowledged')
              )
            )
            .limit(1);
          if (handoff) return Result.Ok({ type: 'cleanup_already_handed_off' });
          const canonical = await canonicalAcknowledgment(
            tx,
            input.fingerprint
          );
          if (canonical) {
            await tx.insert(aliases).values({
              requestId: input.requestId,
              fingerprint: input.fingerprint,
              canonicalRequestId: canonical.requestId,
              createdAt: cleanupNow,
            });
            return Result.Ok(replay(canonical));
          }
          const [event] = await tx
            .insert(recovery)
            .values({
              requestId: input.requestId,
              fingerprint: input.fingerprint,
              outcome: 'cleanup_acknowledged',
              reasonCode: safeBlockedObjectKey(evidence.safeObjectKey)
                ? 'operator_retained'
                : 'locator_unavailable_retained',
              createdAt: cleanupNow,
            })
            .returning();
          if (!event) throw cleanupError('Acknowledgment unavailable');
          return Result.Ok(replay(event));
        }
      );
    } catch (cause) {
      try {
        const event = await findCleanupRecoveryRequest(db, input.requestId);
        if (event) return Result.Ok(replay(event));
      } catch (reconciliationCause) {
        return Result.Error(cleanupError(cause, reconciliationCause));
      }
      return Result.Error(cleanupError(cause));
    }
  };
}
