/**
 * Best-effort in-memory fixed-window rate limiter.
 *
 * IMPORTANT: state is per-process. On serverless/multi-instance deployments
 * (e.g. Vercel) each instance keeps its own counters, so this only bounds abuse
 * per instance. It is defense-in-depth — the primary control for public
 * endpoints should be a platform/edge/WAF rate limit. Keep this lightweight and
 * dependency-free.
 */

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the current window resets (for a `Retry-After` header). */
  retryAfterSeconds: number;
};

type WindowState = {
  count: number;
  resetAt: number;
};

/** Above this many tracked keys, prune expired entries to bound memory. */
const SWEEP_THRESHOLD = 10_000;
const SWEEP_INTERVAL_MS = 30_000;

export type RateLimiterOptions = {
  /** Minimum tracked keys before expired-window pruning runs. */
  sweepThreshold?: number;
  /** Minimum time between pruning passes. */
  sweepIntervalMs?: number;
  /** Observability hook for tests and diagnostics. */
  onSweep?: (trackedKeys: number) => void;
};

export type RateLimiter = {
  /**
   * Records a hit for `key` and reports whether it is within `limit` hits per
   * `windowMs`. The window is fixed (resets `windowMs` after the first hit).
   */
  check: (key: string, limit: number, windowMs: number) => RateLimitResult;
  /** Clears all tracked state. Intended for tests. */
  reset: () => void;
};

export function createRateLimiter(
  now: () => number = Date.now,
  options: RateLimiterOptions = {}
): RateLimiter {
  const windows = new Map<string, WindowState>();
  const sweepThreshold = options.sweepThreshold ?? SWEEP_THRESHOLD;
  const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  const sweep = (currentTime: number) => {
    options.onSweep?.(windows.size);
    for (const [key, state] of windows) {
      if (currentTime >= state.resetAt) windows.delete(key);
    }
  };

  return {
    check: (key, limit, windowMs) => {
      const currentTime = now();
      const existing = windows.get(key);

      if (!existing || currentTime >= existing.resetAt) {
        if (
          windows.size >= sweepThreshold &&
          currentTime - lastSweepAt >= sweepIntervalMs
        ) {
          sweep(currentTime);
          lastSweepAt = currentTime;
        }
        windows.set(key, { count: 1, resetAt: currentTime + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      existing.count += 1;
      if (existing.count > limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((existing.resetAt - currentTime) / 1000)
          ),
        };
      }

      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset: () => {
      windows.clear();
      lastSweepAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/** Shared process-wide limiter used by HTTP handlers. */
export const defaultRateLimiter = createRateLimiter();
