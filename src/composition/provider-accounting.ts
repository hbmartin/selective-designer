import type { Clock } from '@/modules/kernel';
import {
  createProviderAccounting,
  createTelemetryLogger,
} from '@/modules/kernel/backend';
import { systemClock } from '@/modules/kernel/infrastructure/clock/system-clock';
import type { Database } from '@/modules/kernel/infrastructure/db/types';

import { telemetryProxy } from './telemetry';

export const createAccountingGateway = ({
  db,
  clock = systemClock,
}: {
  db: Database;
  clock?: Clock;
}) =>
  createProviderAccounting({
    db,
    clock,
    logger: createTelemetryLogger({ telemetry: telemetryProxy }),
  });
