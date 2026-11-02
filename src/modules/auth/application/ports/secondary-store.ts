import type { ApplicationResult } from '@/modules/kernel';

export type SecondaryStoreGetOutcome =
  | { type: 'secondary_store_hit'; value: string }
  | { type: 'secondary_store_miss' };

export type SecondaryStoreSetOutcome = { type: 'secondary_store_set' };

export type SecondaryStoreDeleteOutcome = { type: 'secondary_store_deleted' };

export type SecondaryStoreTakeOutcome =
  | { type: 'secondary_store_taken'; value: string }
  | { type: 'secondary_store_miss' };

/**
 * Durable key/value port used for Better Auth's secondary storage and
 * rate-limit counters. Implementations decide the backend (in-process map,
 * Upstash Redis, …) so the auth wiring stays provider-neutral.
 *
 * Values are opaque strings; callers serialize/deserialize. `ttlSeconds` is an
 * optional expiry hint — when omitted the entry persists until deleted.
 */
export interface SecondaryStore {
  get(key: string): Promise<ApplicationResult<SecondaryStoreGetOutcome>>;
  set(
    key: string,
    value: string,
    ttlSeconds?: number
  ): Promise<ApplicationResult<SecondaryStoreSetOutcome>>;
  take(
    key: string,
    expectedValue: string
  ): Promise<ApplicationResult<SecondaryStoreTakeOutcome>>;
  delete(key: string): Promise<ApplicationResult<SecondaryStoreDeleteOutcome>>;
}
