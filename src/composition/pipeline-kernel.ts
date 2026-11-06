import type { Clock } from '@/modules/kernel/application/ports/clock';
import type { IdGenerator } from '@/modules/kernel/application/ports/id-generator';
import type { Logger } from '@/modules/kernel/application/ports/logger';
import type { ObjectStoragePort } from '@/modules/kernel/application/ports/object-storage';
import type { ProviderAccounting } from '@/modules/kernel/application/ports/provider-accounting';
import {
  BetterUploadObjectStorage,
  createTelemetryLogger,
  getDefaultDbClient,
} from '@/modules/kernel/backend';
import { systemClock } from '@/modules/kernel/infrastructure/clock/system-clock';
import type { Database } from '@/modules/kernel/infrastructure/db/client';
import { cuidIdGenerator } from '@/modules/kernel/infrastructure/id/nanoid';

import { createAccountingGateway } from './provider-accounting';
import { createCachedFactory } from './shared/singleton';
import { telemetryProxy } from './telemetry';

/**
 * The slice of the kernel that workflow steps need. It deliberately excludes
 * the permission checker (and with it auth, Better Auth and email templates):
 * the Workflow SDK bundles everything a step imports, keeping JSX untransformed
 * in dev, and steps act on persisted ownership rather than a request session.
 */
export type PipelineKernel = {
  db: Database;
  logger: Logger;
  clock: Clock;
  idGenerator: IdGenerator;
  objectStorage: ObjectStoragePort;
  providerAccounting: ProviderAccounting;
};

const factory = createCachedFactory((): PipelineKernel => {
  const db = getDefaultDbClient();
  return {
    db,
    logger: createTelemetryLogger({ telemetry: telemetryProxy }),
    clock: systemClock,
    idGenerator: cuidIdGenerator,
    objectStorage: new BetterUploadObjectStorage(),
    providerAccounting: createAccountingGateway({ db, clock: systemClock }),
  };
});

export const getPipelineKernel = (
  overrides?: Partial<PipelineKernel>
): PipelineKernel => {
  const base = factory.get();
  if (overrides === undefined) return base;
  const db = overrides.db ?? base.db;
  const clock = overrides.clock ?? base.clock;
  return {
    db,
    clock,
    logger: overrides.logger ?? base.logger,
    idGenerator: overrides.idGenerator ?? base.idGenerator,
    objectStorage: overrides.objectStorage ?? base.objectStorage,
    providerAccounting:
      overrides.providerAccounting ??
      (overrides.db || overrides.clock
        ? createAccountingGateway({ db, clock })
        : base.providerAccounting),
  };
};

/** Test-only. */
export const __resetPipelineKernel = () => factory.reset();
