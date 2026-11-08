import { describe, expect, it } from 'vitest';

import {
  isPlausibleRenderStart,
  renderAttemptDeadline,
  RENDER_CLOCK_SKEW_MS,
} from '@/modules/rendering/testing';

describe('render attempt time policy', () => {
  it('keeps representability independent of clock plausibility', () => {
    const start = new Date(8_640_000_000_000_000 - 30 * 60_000);
    expect(renderAttemptDeadline(start)).toEqual({
      type: 'render_deadline_valid',
      deadlineAt: '+275760-09-13T00:00:00.000Z',
    });
    expect(
      isPlausibleRenderStart(
        start.getTime(),
        Date.parse('2026-11-08T12:00:00Z')
      )
    ).toBe(false);
  });
  it.each([NaN, 8_640_000_000_000_000 - 60_000])(
    'rejects unrepresentable deadlines: %s',
    (value) => {
      expect(renderAttemptDeadline(new Date(value))).toEqual({
        type: 'render_deadline_invalid',
      });
    }
  );
  it('accepts the exact future tolerance but rejects the next millisecond', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    expect(isPlausibleRenderStart(now + RENDER_CLOCK_SKEW_MS, now)).toBe(true);
    expect(isPlausibleRenderStart(now + RENDER_CLOCK_SKEW_MS + 1, now)).toBe(
      false
    );
    expect(isPlausibleRenderStart(NaN, now)).toBe(false);
  });
});
