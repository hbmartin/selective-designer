import { Option, Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import type { CacheGateway } from '@/modules/kernel/application/ports/cache-gateway';
import type { Clock } from '@/modules/kernel/application/ports/clock';
import type { IdGenerator } from '@/modules/kernel/application/ports/id-generator';
import type { Logger } from '@/modules/kernel/application/ports/logger';
import type { ObjectStoragePort } from '@/modules/kernel/application/ports/object-storage';
import type { PermissionChecker } from '@/modules/kernel/application/ports/permission-checker';
import type { ProviderAccounting } from '@/modules/kernel/application/ports/provider-accounting';
import type { TransactionRunner } from '@/modules/kernel/application/ports/transaction-runner';
import type { UploadIntentStore } from '@/modules/kernel/application/ports/upload-intent-store';
import {
  BetterUploadObjectStorage,
  createUploadIntentStore,
} from '@/modules/kernel/backend';
import type { UserId } from '@/modules/kernel/domain/ids';
import { systemClock } from '@/modules/kernel/infrastructure/clock/system-clock';
import {
  createTransactionRunner,
  type Database,
  type DbTransaction,
  getDefaultDbClient,
} from '@/modules/kernel/infrastructure/db/client';
import { cuidIdGenerator } from '@/modules/kernel/infrastructure/id/nanoid';
import { createTelemetryLogger } from '@/modules/kernel/infrastructure/logger/telemetry';
import type { TelemetryAdapter } from '@/platform/telemetry';

import { createAccountingGateway } from './provider-accounting';
import { createCachedFactory } from './shared/singleton';
import type { Overrides } from './shared/types';
import { telemetryProxy } from './telemetry';

type CacheEntry = {
  value: unknown;
  expiresAt?: number;
};

const memoryCache = (clock: Clock): CacheGateway => {
  const entries = new Map<string, CacheEntry>();
  return {
    async get<T>(key: string) {
      const entry = entries.get(key);
      if (!entry) return Option.None<T>();
      if (
        entry.expiresAt !== undefined &&
        entry.expiresAt <= clock.now().getTime()
      ) {
        entries.delete(key);
        return Option.None<T>();
      }
      return Option.Some(entry.value as T);
    },
    async set<T>(key: string, value: T, options?: { ttlMs?: number }) {
      entries.set(key, {
        value,
        expiresAt:
          options?.ttlMs === undefined
            ? undefined
            : clock.now().getTime() + options.ttlMs,
      });
    },
    async delete(key: string) {
      entries.delete(key);
    },
  };
};

const createProductionLogger = (): Logger =>
  createTelemetryLogger({ telemetry: telemetryProxy });

const createProductionPermissionChecker = (): PermissionChecker => ({
  async hasPermission(userId: UserId, permissions) {
    const [{ getRequestHeaders }, { getAuthUseCases }] = await Promise.all([
      import('@tanstack/react-start/server'),
      import('./auth'),
    ]);
    const result = await getAuthUseCases().checkPermission({
      userId,
      permissions,
      headers: getRequestHeaders(),
    });
    return match(result)
      .with(Result.P.Error(P.select()), (error) => Result.Error(error))
      .with(Result.P.Ok({ type: 'auth_permission_granted' }), () =>
        Result.Ok({ type: 'permission_granted' as const })
      )
      .with(Result.P.Ok({ type: 'auth_permission_denied' }), () =>
        Result.Ok({ type: 'permission_denied' as const })
      )
      .exhaustive();
  },
});

export type Kernel = {
  db: Database;
  logger: Logger;
  telemetry: TelemetryAdapter;
  clock: Clock;
  idGenerator: IdGenerator;
  cacheGateway: CacheGateway;
  transactionRunner: TransactionRunner<DbTransaction>;
  permissionChecker: PermissionChecker;
  objectStorage: ObjectStoragePort;
  uploadIntentStore: UploadIntentStore;
  providerAccounting: ProviderAccounting;
};

export type KernelOverrides = Overrides<Kernel>;

const buildDefaultKernel = (): Kernel => {
  const db = getDefaultDbClient();
  const clock = systemClock;
  return {
    db,
    logger: createProductionLogger(),
    telemetry: telemetryProxy,
    clock,
    idGenerator: cuidIdGenerator,
    cacheGateway: memoryCache(clock),
    transactionRunner: createTransactionRunner(db),
    permissionChecker: createProductionPermissionChecker(),
    objectStorage: new BetterUploadObjectStorage(),
    uploadIntentStore: createUploadIntentStore({ db }),
    providerAccounting: createAccountingGateway({ db, clock }),
  };
};

const factory = createCachedFactory<Kernel, KernelOverrides>(
  buildDefaultKernel
);

export const getKernel = (overrides?: KernelOverrides): Kernel => {
  if (overrides === undefined) return factory.get();

  const base = factory.get();
  const db = overrides.db ?? base.db;
  const clock = overrides.clock ?? base.clock;
  return {
    db,
    logger: overrides.logger ?? base.logger,
    telemetry: overrides.telemetry ?? base.telemetry,
    clock,
    idGenerator: overrides.idGenerator ?? base.idGenerator,
    cacheGateway:
      overrides.cacheGateway ??
      (overrides.clock !== undefined ? memoryCache(clock) : base.cacheGateway),
    transactionRunner:
      overrides.transactionRunner ??
      (overrides.db !== undefined
        ? createTransactionRunner(db)
        : base.transactionRunner),
    permissionChecker: overrides.permissionChecker ?? base.permissionChecker,
    objectStorage: overrides.objectStorage ?? base.objectStorage,
    uploadIntentStore:
      overrides.uploadIntentStore ??
      (overrides.db !== undefined
        ? createUploadIntentStore({ db })
        : base.uploadIntentStore),
    providerAccounting:
      overrides.providerAccounting ??
      (overrides.db || overrides.clock
        ? createAccountingGateway({ db, clock })
        : base.providerAccounting),
  };
};

/** Test-only. */
export const __resetKernelComposition = () => factory.reset();
