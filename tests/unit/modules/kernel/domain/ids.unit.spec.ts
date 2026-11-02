import { fc, PROPERTY_DEFAULTS, test } from '@tests/support/property-testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ZodError } from 'zod';

import { IdValidationError } from '@/modules/kernel/domain/errors/id-validation-error';
import {
  type EmailAddress,
  type ParseResult,
  type ScopeKey,
  type SessionId,
  toEmailAddress,
  toScopeKey,
  toSessionId,
  toUserId,
  type UserId,
  zEmailAddress,
  zScopeKey,
  zSessionId,
  zUserId,
} from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';

const nonBlankString = fc
  .string({ maxLength: 80 })
  .filter((value) => value.trim().length > 0);

const whitespaceOnlyString = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r', '\v', '\f'), {
    minLength: 1,
    maxLength: 32,
  })
  .map((characters) => characters.join(''));

describe('kernel domain ids', () => {
  it('parses branded IDs from trimmed strings', () => {
    expect(zUserId().parse(' cm123 ')).toBe('cm123');
    expect(zSessionId().parse(' session-1 ')).toBe('session-1');
    expect(zScopeKey().parse(' anonymous ')).toBe('anonymous');
    expect(() => zUserId().parse('')).toThrow(ZodError);
  });

  it('parses email addresses', () => {
    expect(zEmailAddress().parse('user@example.com')).toBe('user@example.com');
    expect(() => zEmailAddress().parse('not-an-email')).toThrow();
  });

  it('converts primitive strings into branded domain values', () => {
    expect(unwrapParseResult(toUserId(' user-1 '))).toBe('user-1');
    expect(unwrapParseResult(toSessionId(' session-1 '))).toBe('session-1');
    expect(unwrapParseResult(toScopeKey(' anonymous '))).toBe('anonymous');
    expect(unwrapParseResult(toEmailAddress(' user@example.com '))).toBe(
      'user@example.com'
    );
    expect(toEmailAddress('not-an-email').isError()).toBe(true);
  });

  it('keeps domain brands distinct at compile time', () => {
    expectTypeOf(toUserId('user-1')).toEqualTypeOf<ParseResult<UserId>>();
    expectTypeOf(toSessionId('session-1')).toEqualTypeOf<
      ParseResult<SessionId>
    >();
    expectTypeOf(toScopeKey('anonymous')).toEqualTypeOf<
      ParseResult<ScopeKey>
    >();
    expectTypeOf(toEmailAddress('user@example.com')).toEqualTypeOf<
      ParseResult<EmailAddress>
    >();
    expectTypeOf(
      unwrapParseResult(toUserId('user-1'))
    ).not.toEqualTypeOf<SessionId>();
    expectTypeOf<string>().not.toExtend<UserId>();
    expectTypeOf<UserId>().toExtend<string>();
  });

  it('returns first-class ID validation errors for blank IDs', () => {
    const result = toUserId('  ');
    expect(result.isError()).toBe(true);
    const error = result.match({
      Ok: () => {
        throw new Error('Expected parser to fail.');
      },
      Error: (value) => value,
    });

    expect(error).toBeInstanceOf(IdValidationError);
    expect(error).toMatchObject({
      name: 'IdValidationError',
      code: 'INVALID_ID',
      details: {
        typeName: 'UserId',
        value: '<blank>',
      },
    });
  });

  it('truncates long invalid ID values in error details', () => {
    const invalidValue = 'x'.repeat(80);

    const result = toEmailAddress(invalidValue);
    expect(result.isError()).toBe(true);
    const error = result.match({
      Ok: () => {
        throw new Error('Expected parser to fail.');
      },
      Error: (value) => value,
    });

    expect(error).toMatchObject({
      details: {
        typeName: 'EmailAddress',
        value: 'xxxxxxxxxxxxxxxxxxxxxxxx...<truncated:80>',
      },
    });
  });

  test.prop([nonBlankString], PROPERTY_DEFAULTS)(
    'trims nonblank primitive IDs for all branded constructors',
    (value) => {
      const expected = value.trim();

      expect(unwrapParseResult(toUserId(value))).toBe(expected);
      expect(unwrapParseResult(toSessionId(value))).toBe(expected);
      expect(unwrapParseResult(toScopeKey(value))).toBe(expected);
    }
  );

  test.prop([whitespaceOnlyString], PROPERTY_DEFAULTS)(
    'throws first-class validation errors for whitespace-only IDs',
    (value) => {
      expect(toUserId(value).isError()).toBe(true);
      expect(toSessionId(value).isError()).toBe(true);
      expect(toScopeKey(value).isError()).toBe(true);
    }
  );

  test.prop([nonBlankString], PROPERTY_DEFAULTS)(
    'keeps Zod ID schemas aligned with branded ID constructors',
    (value) => {
      expect(zUserId().parse(value)).toBe(unwrapParseResult(toUserId(value)));
      expect(zSessionId().parse(value)).toBe(
        unwrapParseResult(toSessionId(value))
      );
      expect(zScopeKey().parse(value)).toBe(
        unwrapParseResult(toScopeKey(value))
      );
    }
  );
});
