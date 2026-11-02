import { Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel';

import type { SecondaryStore } from '../../application/ports/secondary-store';

/**
 * Default {@link SecondaryStore}: a per-process `Map`.
 *
 * IMPORTANT: state is per-process. On serverless / multi-instance deployments
 * each instance keeps its own entries, so Better Auth rate-limit counters and
 * any other shared state only bind abuse per instance. For durable, shared
 * enforcement across instances, configure Upstash Redis
 * (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) so composition selects
 * {@link import('./upstash-secondary-store').UpstashSecondaryStore}, or rely on
 * an edge/WAF control. Expiry is enforced lazily on read plus a size-bounded
 * sweep, mirroring `src/platform/http/rate-limiter.ts`.
 */

type Entry = {
  value: string;
  /** Epoch milliseconds after which the entry is expired, or undefined. */
  expiresAt?: number;
};

/** Above this many tracked keys, prune expired entries to bound memory. */
const SWEEP_THRESHOLD = 10_000;
const SWEEP_INTERVAL_MS = 30_000;
const SWEEP_MAX_ENTRIES = 250;

export type InMemorySecondaryStoreOptions = {
  /** Clock seam for tests. */
  now?: () => number;
  /** Minimum tracked keys before expired-entry pruning runs. */
  sweepThreshold?: number;
  /** Minimum time between pruning passes. */
  sweepIntervalMs?: number;
  /** Maximum entries to inspect during one request-path pruning pass. */
  sweepMaxEntries?: number;
};

export class InMemorySecondaryStore implements SecondaryStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly sweepThreshold: number;
  private readonly sweepIntervalMs: number;
  private readonly sweepMaxEntries: number;
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(options: InMemorySecondaryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sweepThreshold = options.sweepThreshold ?? SWEEP_THRESHOLD;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.sweepMaxEntries = options.sweepMaxEntries ?? SWEEP_MAX_ENTRIES;
  }

  private isExpired(entry: Entry, currentTime: number): boolean {
    return entry.expiresAt !== undefined && currentTime >= entry.expiresAt;
  }

  private sweep(currentTime: number): void {
    const sweepWindow: Array<[string, Entry]> = [];
    for (const item of this.entries.entries()) {
      sweepWindow.push(item);
      if (sweepWindow.length >= this.sweepMaxEntries) break;
    }
    for (const [key, entry] of sweepWindow) {
      this.entries.delete(key);
      if (!this.isExpired(entry, currentTime)) this.entries.set(key, entry);
    }
  }

  private invalidTtlError(ttlSeconds: number) {
    return new AppError({
      code: 'AUTH_SECONDARY_STORE_INVALID_TTL',
      category: 'system',
      status: 500,
      message: 'Secondary store ttlSeconds must be a finite positive number.',
      details: { ttlSeconds },
    });
  }

  async get(key: string): ReturnType<SecondaryStore['get']> {
    const entry = this.entries.get(key);
    if (!entry) return Result.Ok({ type: 'secondary_store_miss' });
    if (this.isExpired(entry, this.now())) {
      this.entries.delete(key);
      return Result.Ok({ type: 'secondary_store_miss' });
    }
    return Result.Ok({ type: 'secondary_store_hit', value: entry.value });
  }

  async set(
    key: string,
    value: string,
    ttlSeconds?: number
  ): ReturnType<SecondaryStore['set']> {
    if (
      ttlSeconds !== undefined &&
      (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)
    ) {
      return Result.Error(this.invalidTtlError(ttlSeconds));
    }

    const currentTime = this.now();
    if (
      this.entries.size >= this.sweepThreshold &&
      currentTime - this.lastSweepAt >= this.sweepIntervalMs
    ) {
      this.sweep(currentTime);
      this.lastSweepAt = currentTime;
    }
    this.entries.set(key, {
      value,
      expiresAt:
        ttlSeconds !== undefined ? currentTime + ttlSeconds * 1000 : undefined,
    });
    return Result.Ok({ type: 'secondary_store_set' });
  }

  async take(
    key: string,
    expectedValue: string
  ): ReturnType<SecondaryStore['take']> {
    const entry = this.entries.get(key);
    if (!entry) return Result.Ok({ type: 'secondary_store_miss' });
    if (this.isExpired(entry, this.now())) {
      this.entries.delete(key);
      return Result.Ok({ type: 'secondary_store_miss' });
    }
    if (entry.value !== expectedValue) {
      return Result.Ok({ type: 'secondary_store_miss' });
    }

    this.entries.delete(key);
    return Result.Ok({ type: 'secondary_store_taken', value: entry.value });
  }

  async delete(key: string): ReturnType<SecondaryStore['delete']> {
    this.entries.delete(key);
    return Result.Ok({ type: 'secondary_store_deleted' });
  }
}
