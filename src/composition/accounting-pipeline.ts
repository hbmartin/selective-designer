import {
  createProviderAccounting,
  createTelemetryLogger,
  getDefaultDbClient,
  pendingProviderReceipts,
  providerAccountingSummary,
} from '@/modules/kernel/backend';
import { systemClock } from '@/modules/kernel/infrastructure/clock/system-clock';

import { createCachedFactory } from './shared/singleton';
import { telemetryProxy } from './telemetry';

/** Workflow-only kernel slice avoids request auth and browser dependencies. */
const factory = createCachedFactory(() => {
  const db = getDefaultDbClient();
  const clock = systemClock;
  const logger = createTelemetryLogger({ telemetry: telemetryProxy });
  const accounting = createProviderAccounting({ db, clock, logger });
  return {
    deliver: accounting.deliver,
    list: (input: { before: string; after?: string }) =>
      pendingProviderReceipts(db, {
        before: new Date(input.before),
        after: input.after,
        limit: 100,
      }),
    async summary() {
      const result = await providerAccountingSummary(db);
      if (result.isOk()) {
        const { pending, oldest } = result.get();
        logger.info({
          event: 'provider_accounting.summary',
          details: {
            pending,
            oldestPendingAgeMs:
              oldest === null
                ? null
                : Math.max(
                    0,
                    clock.now().getTime() - new Date(oldest).getTime()
                  ),
          },
        });
      }
      return result;
    },
    startedAt: () => clock.now().toISOString(),
  };
});
export const getAccountingRecovery = () => factory.get();
