import { Option, Result } from '@bloodyowl/boxed';

import type { Kernel } from '@/composition/kernel';
import { toGeneratedId } from '@/modules/kernel/domain/ids';
import { createNoOpTelemetry } from '@/platform/telemetry';

export const now = new Date('2026-01-01T00:00:00.000Z');

export function makeTestKernel(overrides: Partial<Kernel> = {}): Kernel {
  const cache = new Map<string, unknown>();
  return {
    db: {} as Kernel['db'],
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    telemetry: createNoOpTelemetry(),
    clock: {
      now: () => now,
    },
    idGenerator: {
      createId: () => toGeneratedId('generated-id'),
    },
    cacheGateway: {
      async get<T>(key: string) {
        return cache.has(key)
          ? Option.Some(cache.get(key) as T)
          : Option.None<T>();
      },
      async set<T>(key: string, value: T) {
        cache.set(key, value);
      },
      async delete(key: string) {
        cache.delete(key);
      },
    },
    transactionRunner: {
      run: (work) => work({} as never),
    },
    permissionChecker: {
      hasPermission: async () => Result.Ok({ type: 'permission_granted' }),
    },
    ...overrides,
  };
}
