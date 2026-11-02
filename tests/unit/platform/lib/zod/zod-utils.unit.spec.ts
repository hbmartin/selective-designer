import { describe, expect, it } from 'vitest';

import { zu } from '@/platform/lib/zod/zod-utils';

describe('zod form utilities', () => {
  it('trims required text and rejects blank text with the configured error key', () => {
    const schema = zu.fieldText.required({ error: 'field.required' });

    expect(schema.parse('  Alice  ')).toBe('Alice');
    expect(schema.safeParse('   ')).toMatchObject({
      success: false,
      error: {
        issues: [
          {
            message: 'field.required',
          },
        ],
      },
    });
  });

  it('normalizes blank nullable and nullish text to null', () => {
    expect(zu.fieldText.nullable().parse('   ')).toBeNull();
    expect(zu.fieldText.nullable().parse(null)).toBeNull();
    expect(zu.fieldText.nullish().parse('   ')).toBeNull();
    expect(zu.fieldText.nullish().parse(null)).toBeNull();
    expect(zu.fieldText.nullish().parse(undefined)).toBeUndefined();
  });

  it('normalizes blank optional text to undefined while trimming provided text', () => {
    const schema = zu.fieldText.optional();

    expect(schema.parse('   ')).toBeUndefined();
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse('  visible  ')).toBe('visible');
  });

  it('rejects required text past the configured max with the maxLength key', () => {
    const schema = zu.fieldText.required({ max: 5 });

    expect(schema.parse('  abc  ')).toBe('abc');
    expect(schema.safeParse('abcdef')).toMatchObject({
      success: false,
      error: { issues: [{ message: 'common:errors.maxLength' }] },
    });
  });

  it('applies max to nullish text while preserving null normalization', () => {
    const schema = zu.fieldText.nullish({ max: 3 });

    expect(schema.parse('  ab  ')).toBe('ab');
    expect(schema.parse('   ')).toBeNull();
    expect(schema.safeParse('abcd')).toMatchObject({ success: false });
  });
});
