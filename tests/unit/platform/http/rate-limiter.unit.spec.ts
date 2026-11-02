import { describe, expect, it, vi } from 'vitest';

import { createRateLimiter } from '@/platform/http/rate-limiter';

describe('createRateLimiter', () => {
  it('allows up to the limit within a window then denies', () => {
    let now = 1_000;
    const limiter = createRateLimiter(() => now);

    expect(limiter.check('k', 2, 60_000).allowed).toBe(true);
    expect(limiter.check('k', 2, 60_000).allowed).toBe(true);

    const denied = limiter.check('k', 2, 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets after the window elapses', () => {
    let now = 1_000;
    const limiter = createRateLimiter(() => now);

    expect(limiter.check('k', 1, 60_000).allowed).toBe(true);
    expect(limiter.check('k', 1, 60_000).allowed).toBe(false);

    now += 60_000;
    expect(limiter.check('k', 1, 60_000).allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    const limiter = createRateLimiter(() => 0);

    expect(limiter.check('a', 1, 60_000).allowed).toBe(true);
    expect(limiter.check('b', 1, 60_000).allowed).toBe(true);
    expect(limiter.check('a', 1, 60_000).allowed).toBe(false);
  });

  it('clears state on reset', () => {
    const limiter = createRateLimiter(() => 0);

    expect(limiter.check('k', 1, 60_000).allowed).toBe(true);
    expect(limiter.check('k', 1, 60_000).allowed).toBe(false);

    limiter.reset();
    expect(limiter.check('k', 1, 60_000).allowed).toBe(true);
  });

  it('throttles expired-key sweeps once the key threshold is reached', () => {
    let now = 0;
    const onSweep = vi.fn();
    const limiter = createRateLimiter(() => now, {
      onSweep,
      sweepIntervalMs: 30_000,
      sweepThreshold: 2,
    });

    expect(limiter.check('a', 1, 60_000).allowed).toBe(true);
    expect(limiter.check('b', 1, 60_000).allowed).toBe(true);
    expect(limiter.check('c', 1, 60_000).allowed).toBe(true);
    expect(onSweep).toHaveBeenCalledTimes(1);

    expect(limiter.check('d', 1, 60_000).allowed).toBe(true);
    expect(onSweep).toHaveBeenCalledTimes(1);

    now += 30_000;
    expect(limiter.check('e', 1, 60_000).allowed).toBe(true);
    expect(onSweep).toHaveBeenCalledTimes(2);

    limiter.reset();
    expect(limiter.check('f', 1, 60_000).allowed).toBe(true);
    expect(limiter.check('g', 1, 60_000).allowed).toBe(true);
    expect(limiter.check('h', 1, 60_000).allowed).toBe(true);
    expect(onSweep).toHaveBeenCalledTimes(3);
  });
});
