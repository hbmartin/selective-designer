import type { ApplicationResult } from '@/modules/kernel';

export type SecondaryStoreGetOutcome =
  | { type: 'secondary_store_hit'; value: string }
  | { type: 'secondary_store_miss' };

export type SecondaryStoreSetOutcome = { type: 'secondary_store_set' };

export type SecondaryStoreDeleteOutcome = { type: 'secondary_store_deleted' };

export type SecondaryStoreTakeOutcome =
  | { type: 'secondary_store_taken'; value: string }
  | { type: 'secondary_store_miss' };

export type SecondaryStoreIncrementOutcome = {
  type: 'secondary_store_incremented';
  value: number;
};

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
  /** Atomically read and remove a value. */
  getAndDelete(
    key: string
  ): Promise<ApplicationResult<SecondaryStoreTakeOutcome>>;
  /**
   * Atomically add one to the integer counter at `key`, returning the new
   * value. A missing key starts at 1 with `ttlSeconds`; later increments keep
   * the original expiry (fixed window).
   */
  increment(
    key: string,
    ttlSeconds: number
  ): Promise<ApplicationResult<SecondaryStoreIncrementOutcome>>;
  delete(key: string): Promise<ApplicationResult<SecondaryStoreDeleteOutcome>>;
}
