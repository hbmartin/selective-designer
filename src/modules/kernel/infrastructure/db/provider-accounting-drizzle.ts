import { Result } from '@bloodyowl/boxed';
import { and, asc, count, eq, isNull, lte, min, sql } from 'drizzle-orm';

import { createTransactionRunner } from './client';
import { dispatchProviderReceipt } from './provider-accounting-dispatch';
import { createProviderCallLog } from './provider-call-log-drizzle';
import { providerCallReceipt as receiptTable } from './schema/provider-call-receipt';
import type { Database, DbLike } from './types';
import type { Clock } from '../../application/ports/clock';
import type { Logger } from '../../application/ports/logger';
import type {
  ProviderAccounting,
  ProviderCallReceipt,
  ReceiptCaptured,
} from '../../application/ports/provider-accounting';
import type { ProviderCallRecord } from '../../application/ports/provider-call-log';
import type { ApplicationResult } from '../../application/result';
import { AppError } from '../../domain/errors/app-error';
import { safeErrorDiagnostics } from '../../domain/errors/safe-error-diagnostics';
import { toProviderCallId, toUserId } from '../../domain/ids';

const accountingError = (cause: unknown) =>
  new AppError({
    code: 'PROVIDER_ACCOUNTING_FAILED',
    category: 'system',
    status: 500,
    message: 'Provider accounting persistence failed',
    cause,
  });

/** JSON timestamps are parsed exactly once at this persistence boundary. */
const receiptValues = (receipt: ProviderCallReceipt) => {
  const startedAt = new Date(receipt.startedAt);
  const completedAt =
    receipt.completedAt === undefined ? null : new Date(receipt.completedAt);
  if (
    !Number.isFinite(startedAt.getTime()) ||
    (completedAt !== null && !Number.isFinite(completedAt.getTime()))
  )
    throw accountingError('Invalid provider receipt timestamp');
  if (receipt.providerRequestId?.includes('://'))
    throw accountingError('Provider request identity must not be a URL');
  return {
    ...receipt,
    userId: receipt.userId ?? null,
    designId: receipt.designId ?? null,
    subjectId: receipt.subjectId ?? null,
    providerRequestId: receipt.providerRequestId ?? null,
    costUsdMicros: receipt.costUsdMicros ?? null,
    startedAt,
    completedAt,
  };
};

/** Transaction-scoped capture only: never deliver into provider_call here. */
export const createProviderReceiptStore = ({ db }: { db: DbLike }) => ({
  async capture(
    receipt: ProviderCallReceipt
  ): Promise<ApplicationResult<ReceiptCaptured>> {
    try {
      const values = receiptValues(receipt);
      await db.insert(receiptTable).values(values).onConflictDoNothing();
      const [saved] = await db
        .select()
        .from(receiptTable)
        .where(eq(receiptTable.id, receipt.id));
      if (
        !saved ||
        saved.provider !== receipt.provider ||
        saved.endpoint !== receipt.endpoint ||
        saved.providerRequestId !== (receipt.providerRequestId ?? null) ||
        saved.purpose !== receipt.purpose ||
        saved.subjectId !== (receipt.subjectId ?? null) ||
        saved.designId !== (receipt.designId ?? null)
      )
        return Result.Error(
          accountingError('Provider receipt identity mismatch')
        );
      // Terminal success is immutable. An earlier submitted/failed record can advance.
      if (saved.status !== 'succeeded' && receipt.status === 'succeeded') {
        await db
          .update(receiptTable)
          .set({ ...values, deliveredAt: null })
          .where(
            and(
              eq(receiptTable.id, receipt.id),
              sql`${receiptTable.status} <> 'succeeded'`
            )
          );
      }
      return Result.Ok({
        type: 'receipt_captured' as const,
        receiptId: receipt.id,
      });
    } catch (cause) {
      return Result.Error(accountingError(cause));
    }
  },
});

const toCall = (row: typeof receiptTable.$inferSelect): ProviderCallRecord => {
  const id = toProviderCallId(row.id);
  const userId = row.userId === null ? undefined : toUserId(row.userId);
  if (
    id.isError() ||
    userId?.isError() ||
    !['render', 'segmentation', 'background_removal'].includes(row.purpose) ||
    !['submitted', 'succeeded', 'failed'].includes(row.status) ||
    !['reported', 'price_table', 'unavailable'].includes(row.costSource)
  )
    throw accountingError('Invalid provider receipt');
  return {
    id: id.get(),
    userId: userId?.isOk() ? userId.get() : undefined,
    designId: row.designId ?? undefined,
    subjectId: row.subjectId ?? undefined,
    purpose: row.purpose as ProviderCallRecord['purpose'],
    provider: row.provider,
    endpoint: row.endpoint,
    providerRequestId: row.providerRequestId ?? undefined,
    status: row.status as ProviderCallRecord['status'],
    costUsdMicros: row.costUsdMicros ?? undefined,
    costSource: row.costSource as ProviderCallRecord['costSource'],
    details: row.details,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
  };
};

export const createProviderAccounting = ({
  db,
  clock,
  logger,
  schedule,
}: {
  db: Database;
  clock: Clock;
  logger: Logger;
  schedule?: (receiptId: ProviderCallRecord['id']) => Promise<void>;
}): ProviderAccounting => {
  const deliver: ProviderAccounting['deliver'] = async (receiptId) => {
    try {
      const [existing] = await db
        .select({ deliveredAt: receiptTable.deliveredAt })
        .from(receiptTable)
        .where(eq(receiptTable.id, receiptId));
      if (!existing) return Result.Ok({ type: 'receipt_missing' });
      if (existing.deliveredAt) return Result.Ok({ type: 'receipt_delivered' });
      return await createTransactionRunner(db).run(async (tx) => {
        await tx.execute(
          sql`select set_config('lock_timeout', '1s', true), set_config('statement_timeout', '5s', true), set_config('idle_in_transaction_session_timeout', '5s', true)`
        );
        const [row] = await tx
          .select()
          .from(receiptTable)
          .where(eq(receiptTable.id, receiptId))
          .for('update', { skipLocked: true });
        if (!row) {
          const [exists] = await tx
            .select({ id: receiptTable.id })
            .from(receiptTable)
            .where(eq(receiptTable.id, receiptId));
          return Result.Ok({
            type: exists
              ? ('receipt_pending' as const)
              : ('receipt_missing' as const),
          });
        }
        if (row.deliveredAt)
          return Result.Ok({ type: 'receipt_delivered' as const });
        const delivered = await createProviderCallLog({ db: tx }).record(
          toCall(row)
        );
        if (delivered.isError()) throw delivered.getError();
        await tx
          .update(receiptTable)
          .set({
            deliveredAt: clock.now(),
            lastErrorCode: null,
            deliveryAttempts: sql`${receiptTable.deliveryAttempts} + 1`,
          })
          .where(eq(receiptTable.id, receiptId));
        return Result.Ok({ type: 'receipt_delivered' as const });
      });
    } catch (cause) {
      const error = accountingError(cause);
      logger.warn({
        event: 'provider_accounting.delivery_failed',
        details: {
          receiptId,
          code: error.code,
          ...safeErrorDiagnostics(cause),
        },
      });
      try {
        await db
          .update(receiptTable)
          .set({
            lastErrorCode: error.code,
            deliveryAttempts: sql`${receiptTable.deliveryAttempts} + 1`,
          })
          .where(
            and(
              eq(receiptTable.id, receiptId),
              isNull(receiptTable.deliveredAt)
            )
          );
      } catch (failure) {
        logger.warn({
          event: 'provider_accounting.failure_diagnostic_write_failed',
          details: { receiptId, code: accountingError(failure).code },
        });
      }
      return Result.Error(error);
    }
  };
  return {
    deliver,
    async capture(receipt) {
      let saved = await createProviderReceiptStore({ db }).capture(receipt);
      if (saved.isError()) {
        const original = saved.getError();
        // A lost write reply may still have committed. Only matching durable identity reconciles it.
        try {
          const expected = receiptValues(receipt);
          const [found] = await db
            .select()
            .from(receiptTable)
            .where(eq(receiptTable.id, receipt.id));
          if (
            found &&
            found.provider === expected.provider &&
            found.endpoint === expected.endpoint &&
            found.providerRequestId === expected.providerRequestId &&
            found.purpose === expected.purpose &&
            found.subjectId === expected.subjectId &&
            found.designId === expected.designId
          )
            saved = Result.Ok({
              type: 'receipt_captured',
              receiptId: receipt.id,
            });
        } catch (failure) {
          logger.warn({
            event: 'provider_accounting.reconciliation_failed',
            details: {
              receiptId: receipt.id,
              code: original.code,
              ...safeErrorDiagnostics(failure),
            },
          });
        }
        if (saved.isError()) return Result.Error(original);
      }
      if (schedule) {
        try {
          await dispatchProviderReceipt(schedule, saved.get().receiptId);
        } catch (cause) {
          logger.warn({
            event: 'provider_accounting.dispatch_failed',
            details: {
              receiptId: receipt.id,
              code: accountingError(cause).code,
              ...safeErrorDiagnostics(cause),
            },
          });
        }
      }
      return saved;
    },
  };
};

/** Snapshot pagination ensures one bad receipt cannot be selected forever in a run. */
export async function pendingProviderReceipts(
  db: Database,
  input: { before: Date; after?: string; limit: number }
): Promise<ApplicationResult<{ type: 'pending_receipts'; ids: string[] }>> {
  try {
    const rows = await db
      .select({ id: receiptTable.id })
      .from(receiptTable)
      .where(
        and(
          isNull(receiptTable.deliveredAt),
          lte(receiptTable.createdAt, input.before),
          input.after === undefined
            ? undefined
            : sql`${receiptTable.id} > ${input.after}`
        )
      )
      .orderBy(asc(receiptTable.id))
      .limit(input.limit);
    return Result.Ok({
      type: 'pending_receipts' as const,
      ids: rows.map((row) => row.id),
    });
  } catch (cause) {
    return Result.Error(accountingError(cause));
  }
}
export async function providerAccountingSummary(db: Database): Promise<
  ApplicationResult<{
    type: 'accounting_summary';
    pending: number;
    oldest: Date | null;
  }>
> {
  try {
    const [row] = await db
      .select({ pending: count(), oldest: min(receiptTable.createdAt) })
      .from(receiptTable)
      .where(isNull(receiptTable.deliveredAt));
    return Result.Ok({
      type: 'accounting_summary' as const,
      pending: row?.pending ?? 0,
      oldest: row?.oldest ?? null,
    });
  } catch (cause) {
    return Result.Error(accountingError(cause));
  }
}
