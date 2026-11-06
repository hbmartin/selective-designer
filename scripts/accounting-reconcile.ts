import type { Logger } from '../src/modules/kernel';
import {
  createProviderAccounting,
  getDefaultDbClient,
  pendingProviderReceipts,
  providerAccountingSummary,
} from '../src/modules/kernel/backend';
import { actionableErrorCode } from '../src/modules/kernel/domain/errors/actionable-error-code';
import { safeErrorDiagnostics } from '../src/modules/kernel/domain/errors/safe-error-diagnostics';
import { toProviderCallId } from '../src/modules/kernel/domain/ids';
import { systemClock } from '../src/modules/kernel/infrastructure/clock/system-clock';

const logger: Logger = {
  debug: () => {},
  info: (event) => console.log(event.event, event.details),
  warn: (event) => console.warn(event.event, event.details),
  error: (event) => console.error(event.event, event.details),
};
let db: ReturnType<typeof getDefaultDbClient> | undefined;
try {
  db = getDefaultDbClient();
  const accounting = createProviderAccounting({
    db,
    clock: systemClock,
    logger,
  });
  const before = systemClock.now();
  let after: string | undefined;
  let delivered = 0;
  let failed = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- bounded cursor pagination.
    const page = await pendingProviderReceipts(db, {
      before,
      after,
      limit: 100,
    });
    if (page.isError()) throw page.getError();
    if (!page.get().ids.length) break;
    for (const value of page.get().ids) {
      const id = toProviderCallId(value);
      if (id.isError()) {
        failed++;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- short isolated delivery transaction per receipt.
      const result = await accounting.deliver(id.get());
      if (result.isError()) failed++;
      else if (result.get().type === 'receipt_delivered') delivered++;
    }
    after = page.get().ids.at(-1);
  }
  const summary = await providerAccountingSummary(db);
  if (summary.isError()) throw summary.getError();
  console.log({ delivered, failed, ...summary.get() });
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error('Accounting reconciliation failed.', {
    code: actionableErrorCode(error, 'PROVIDER_ACCOUNTING_FAILED'),
    ...safeErrorDiagnostics(error),
  });
  process.exitCode = 1;
} finally {
  try {
    await db?.$close();
  } catch (error) {
    console.error('Closing the accounting database connection failed.', {
      code: actionableErrorCode(error, 'DATABASE_CLOSE_FAILED'),
      ...safeErrorDiagnostics(error),
    });
    process.exitCode = 1;
  }
}
