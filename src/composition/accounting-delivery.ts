import { getEnv, waitUntil } from '@vercel/functions';

import type { Logger, ProviderAccounting } from '@/modules/kernel';
import type { UseCaseScope } from '@/modules/kernel/application/bind-use-cases';
import { safeErrorDiagnostics } from '@/modules/kernel/domain/errors/safe-error-diagnostics';
import type { ProviderCallId } from '@/modules/kernel/domain/ids';
import { dispatchProviderReceipt } from '@/modules/kernel/infrastructure/db/provider-accounting-dispatch';

const schedule = async (receiptId: ProviderCallId) => {
  const [{ start }, { accountingDeliveryWorkflow }] = await Promise.all([
    import('workflow/api'),
    import('@/modules/kernel/workflows/backend'),
  ]);
  await start(accountingDeliveryWorkflow, [{ receiptId }]);
};

/** The deployed Vercel request host owns waitUntil, independently of deadline metadata. */
export function deferAccountingDelivery(
  task: () => Promise<void>,
  logger: Logger
) {
  try {
    const env = getEnv();
    if (
      env.VERCEL !== '1' ||
      !['production', 'preview'].includes(env.VERCEL_ENV ?? '')
    ) {
      logger.info({
        event: 'provider_accounting.dispatch_deferred',
        details: { reason: 'request_lifetime_unavailable' },
      });
      return;
    }
    waitUntil(task());
  } catch (error) {
    logger.warn({
      event: 'provider_accounting.dispatch_failed',
      details: {
        reason: 'request_lifetime_failed',
        ...safeErrorDiagnostics(error),
      },
    });
  }
}

/** Each factory binds definitions once; the scope isolates dependencies per invocation. */
export function createAccountingScope<
  D extends { providerAccounting: ProviderAccounting },
>(input: { logger: Logger; owner: 'workflow' | 'http' }): UseCaseScope<D> {
  return (deps, value, operation) =>
    withAccountingDelivery({
      ...input,
      accounting: deps.providerAccounting,
      operation: (providerAccounting) =>
        operation({ ...deps, providerAccounting }, value),
    });
}

/** A workflow-owned post-operation step may dispatch a previously captured receipt. */
export async function dispatchAccountingReceipt(input: {
  receiptId: ProviderCallId;
  logger: Logger;
  schedule?: typeof schedule;
}) {
  try {
    await dispatchProviderReceipt(input.schedule ?? schedule, input.receiptId);
  } catch (error) {
    input.logger.warn({
      event: 'provider_accounting.dispatch_failed',
      details: { receiptId: input.receiptId, ...safeErrorDiagnostics(error) },
    });
  }
}

/** Per-operation scope: receipt identifiers never become browser or workflow output data. */
export async function withAccountingDelivery<T>(input: {
  accounting: ProviderAccounting;
  logger: Logger;
  owner: 'workflow' | 'http';
  operation: (accounting: ProviderAccounting) => Promise<T>;
  schedule?: typeof schedule;
  defer?: typeof deferAccountingDelivery;
}): Promise<T> {
  const ids = new Set<ProviderCallId>();
  const accounting: ProviderAccounting = {
    deliver: input.accounting.deliver,
    async capture(receipt) {
      const captured = await input.accounting.capture(receipt);
      if (captured.isOk()) ids.add(captured.get().receiptId);
      return captured;
    },
  };
  try {
    return await input.operation(accounting);
  } finally {
    const dispatch = async () => {
      await Promise.allSettled(
        [...ids].map((receiptId) =>
          dispatchAccountingReceipt({
            receiptId,
            logger: input.logger,
            schedule: input.schedule,
          })
        )
      );
    };
    if (ids.size) {
      if (input.owner === 'workflow') await dispatch();
      else (input.defer ?? deferAccountingDelivery)(dispatch, input.logger);
    }
  }
}
