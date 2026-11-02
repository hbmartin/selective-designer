import { describe, expect, it } from 'vitest';

import { AUTH_REAUTH_REQUIRED, isSessionFresh } from '@/modules/auth';

const now = Date.parse('2026-06-27T12:00:00.000Z');
const freshAgeSeconds = 900; // 15 minutes

describe('isSessionFresh', () => {
  it('is fresh when createdAt is within the window', () => {
    const createdAtMs = now - 5 * 60 * 1000; // 5 min ago
    expect(isSessionFresh({ createdAtMs, freshAgeSeconds, now })).toBe(true);
  });

  it('is fresh exactly at the window boundary', () => {
    const createdAtMs = now - freshAgeSeconds * 1000; // 15 min ago
    expect(isSessionFresh({ createdAtMs, freshAgeSeconds, now })).toBe(true);
  });

  it('is stale when createdAt is older than the window', () => {
    const createdAtMs = now - 16 * 60 * 1000; // 16 min ago
    expect(isSessionFresh({ createdAtMs, freshAgeSeconds, now })).toBe(false);
  });

  it('fails closed when createdAt is missing (undefined)', () => {
    expect(
      isSessionFresh({ createdAtMs: undefined, freshAgeSeconds, now })
    ).toBe(false);
  });

  it('fails closed when createdAt is null', () => {
    expect(isSessionFresh({ createdAtMs: null, freshAgeSeconds, now })).toBe(
      false
    );
  });

  it('fails closed when createdAtMs is invalid', () => {
    expect(
      isSessionFresh({ createdAtMs: Number.NaN, freshAgeSeconds, now })
    ).toBe(false);
  });
});

describe('AUTH_REAUTH_REQUIRED', () => {
  it('is the shared step-up signal value', () => {
    expect(AUTH_REAUTH_REQUIRED).toBe('reauth_required');
  });
});
