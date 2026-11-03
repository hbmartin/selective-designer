import { describe, expect, it } from 'vitest';

import { createRegionsPolling } from '@/modules/segmentation/testing';

const query = (count: number | null) => ({
  state: { data: count === null ? undefined : Array.from({ length: count }) },
});

describe('regions polling', () => {
  it('polls until the region count settles, then stops', () => {
    let now = 0;
    const interval = createRegionsPolling(() => now);
    expect(interval(query(null))).toBe(3000);
    expect(interval(query(0))).toBe(3000);
    now = 3000;
    expect(interval(query(2))).toBe(3000);
    now = 13_000;
    expect(interval(query(2))).toBe(3000);
    now = 19_000;
    expect(interval(query(2))).toBe(false);
    now = 20_000;
    expect(interval(query(5))).toBe(3000);
  });

  it('stops after the detection window even without regions', () => {
    let now = 0;
    const interval = createRegionsPolling(() => now);
    now = 121_000;
    expect(interval(query(0))).toBe(false);
  });
});
