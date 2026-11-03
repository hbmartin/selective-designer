import { describe, expect, it } from 'vitest';

import { shapesBox } from '@/platform/components/canvas';

describe('shapesBox', () => {
  const size = { width: 200, height: 100 };

  it('bounds polygons', () => {
    expect(
      shapesBox(
        [{ kind: 'polygon', points: [0.1, 0.2, 0.5, 0.2, 0.3, 0.6] }],
        size
      )
    ).toEqual({ x: 0.1, y: 0.2, width: 0.4, height: expect.closeTo(0.4, 10) });
  });

  it('pads strokes by half their width, in each axis', () => {
    // 0.1 of 200 px = 20 px wide brush: ±0.05 in x, ±0.1 in y.
    const box = shapesBox(
      [{ kind: 'stroke', points: [0.5, 0.5, 0.6, 0.5], widthFraction: 0.1 }],
      size
    );
    expect(box?.x).toBeCloseTo(0.45);
    expect(box?.width).toBeCloseTo(0.2);
    expect(box?.y).toBeCloseTo(0.4);
    expect(box?.height).toBeCloseTo(0.2);
  });

  it('clamps to the image and rejects empty shapes', () => {
    expect(
      shapesBox(
        [{ kind: 'stroke', points: [0, 0, 0.1, 0], widthFraction: 0.2 }],
        size
      )
    ).toMatchObject({ x: 0, y: 0 });
    expect(
      shapesBox([{ kind: 'polygon', points: [0.3, 0.3] }], size)
    ).toBeNull();
    expect(shapesBox([], size)).toBeNull();
  });
});
