import { okValue } from '@tests/support/result';
import { describe, expect, it } from 'vitest';

import {
  haveSameFraming,
  isConsistentWorkingCopy,
  isValidImageDimensions,
  toDesignName,
  workingImageSize,
} from '@/modules/design';

describe('design domain', () => {
  it('trims design names and rejects blank or overlong ones', () => {
    expect(okValue(toDesignName('  Lakeside Villa  '))).toBe('Lakeside Villa');
    expect(toDesignName('   ').isError()).toBe(true);
    expect(toDesignName('x'.repeat(121)).isError()).toBe(true);
  });

  it('scales working copies to a 2048 px long edge without upscaling', () => {
    expect(workingImageSize({ width: 6000, height: 4000 })).toEqual({
      width: 2048,
      height: 1365,
    });
    expect(workingImageSize({ width: 1600, height: 900 })).toEqual({
      width: 1600,
      height: 900,
    });
    expect(workingImageSize({ width: 3000, height: 5000 })).toEqual({
      width: 1229,
      height: 2048,
    });
  });

  it('accepts only working copies derived from the original', () => {
    const original = { width: 6000, height: 4000 };
    expect(
      isConsistentWorkingCopy({
        original,
        working: { width: 2048, height: 1366 },
      })
    ).toBe(true);
    expect(
      isConsistentWorkingCopy({
        original,
        working: { width: 6000, height: 4000 },
      })
    ).toBe(false);
  });

  it('validates dimensions and compares framing within 1%', () => {
    expect(isValidImageDimensions({ width: 0, height: 10 })).toBe(false);
    expect(isValidImageDimensions({ width: 1.5, height: 10 })).toBe(false);
    expect(isValidImageDimensions({ width: 2048, height: 1365 })).toBe(true);
    expect(
      haveSameFraming(
        { width: 2048, height: 1365 },
        { width: 1536, height: 1024 }
      )
    ).toBe(true);
    expect(
      haveSameFraming(
        { width: 2048, height: 1365 },
        { width: 1024, height: 1024 }
      )
    ).toBe(false);
  });
});
