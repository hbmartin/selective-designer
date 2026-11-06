import type { Logger } from '../src/modules/kernel';
import {
  createProviderAccounting,
  getDefaultDbClient,
  pendingProviderReceipts,
  providerAccountingSummary,
} from '../src/modules/kernel/backend';
import { toProviderCallId } from '../src/modules/kernel/domain/ids';
import { systemClock } from '../src/modules/kernel/infrastructure/clock/system-clock';

const logger: Logger = {
  debug: () => {},
  info: (event) => console.log(event.event, event.details),
  warn: (event) => console.warn(event.event, event.details),
  error: (event) => console.error(event.event, event.details),
};
const db = getDefaultDbClient();
try {
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
} catch {
  console.error(
    'Accounting reconciliation failed. Check database configuration and safe accounting logs.'
  );
  process.exitCode = 1;
} finally {
  await db.$close();
}
