import { AppError } from '../../domain/errors/app-error';
import type { ProviderCallId } from '../../domain/ids';

export const ACCOUNTING_DISPATCH_TIMEOUT_MS = 5_000;
/** A late queue response is harmless: receipts and delivery are idempotent. */
export async function dispatchProviderReceipt(
  schedule: (id: ProviderCallId) => Promise<void>,
  id: ProviderCallId
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      schedule(id),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new AppError({
                code: 'ACCOUNTING_DISPATCH_TIMEOUT',
                category: 'system',
                status: 503,
                message: 'Accounting dispatch timed out',
              })
            ),
          ACCOUNTING_DISPATCH_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
