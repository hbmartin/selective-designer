import { fc, PROPERTY_DEFAULTS, test } from '@tests/support/property-testing';
import { describe, expect, it } from 'vitest';

import { toEmailAddress, toUserId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { shouldUnverifyEmail } from '@/modules/user/domain/user';
import {
  assignsPrivilegedRole,
  canChangeRole,
  isSelfTarget,
} from '@/modules/user/domain/user-policy';

const localEmailCharacter = fc.constantFrom(
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9'
);
const safeEmail = fc
  .array(localEmailCharacter, { minLength: 1, maxLength: 24 })
  .map((localPart) =>
    unwrapParseResult(toEmailAddress(`${localPart.join('')}@example.com`))
  );
const nonBlankUserId = fc
  .string({ maxLength: 40 })
  .filter((value) => value.trim().length > 0)
  .map((value) => unwrapParseResult(toUserId(value)));
const role = fc.constantFrom('admin' as const, 'user' as const);

describe('user domain', () => {
  it('unverifies users only when their email changes', () => {
    expect(
      shouldUnverifyEmail(
        unwrapParseResult(toEmailAddress('old@example.com')),
        unwrapParseResult(toEmailAddress('new@example.com'))
      )
    ).toBe(true);

    expect(
      shouldUnverifyEmail(
        unwrapParseResult(toEmailAddress('same@example.com')),
        unwrapParseResult(toEmailAddress('same@example.com'))
      )
    ).toBe(false);
  });

  it('detects self-target operations', () => {
    expect(
      isSelfTarget(
        unwrapParseResult(toUserId('user-1')),
        unwrapParseResult(toUserId('user-1'))
      )
    ).toBe(true);
    expect(
      isSelfTarget(
        unwrapParseResult(toUserId('user-1')),
        unwrapParseResult(toUserId('user-2'))
      )
    ).toBe(false);
  });

  it('flags only explicitly-requested privileged roles', () => {
    expect(assignsPrivilegedRole('admin')).toBe(true);
    expect(assignsPrivilegedRole('user')).toBe(false);
    expect(assignsPrivilegedRole(null)).toBe(false);
    expect(assignsPrivilegedRole(undefined)).toBe(false);
  });

  it('allows role changes only for other users with a different requested role', () => {
    expect(
      canChangeRole({
        currentUserId: unwrapParseResult(toUserId('admin-1')),
        userId: unwrapParseResult(toUserId('user-1')),
        nextRole: 'admin',
        currentRole: 'user',
      })
    ).toBe(true);

    expect(
      canChangeRole({
        currentUserId: unwrapParseResult(toUserId('user-1')),
        userId: unwrapParseResult(toUserId('user-1')),
        nextRole: 'admin',
        currentRole: 'user',
      })
    ).toBe(false);
    expect(
      canChangeRole({
        currentUserId: unwrapParseResult(toUserId('admin-1')),
        userId: unwrapParseResult(toUserId('user-1')),
        nextRole: undefined,
        currentRole: 'user',
      })
    ).toBe(false);
    expect(
      canChangeRole({
        currentUserId: unwrapParseResult(toUserId('admin-1')),
        userId: unwrapParseResult(toUserId('user-1')),
        nextRole: 'user',
        currentRole: 'user',
      })
    ).toBe(false);
  });

  test.prop([safeEmail, safeEmail], PROPERTY_DEFAULTS)(
    'unverifies generated email updates exactly when the address changes',
    (currentEmail, nextEmail) => {
      expect(shouldUnverifyEmail(currentEmail, nextEmail)).toBe(
        currentEmail !== nextEmail
      );
    }
  );

  test.prop([nonBlankUserId, nonBlankUserId], PROPERTY_DEFAULTS)(
    'detects generated self-target operations by ID equality',
    (currentUserId, targetUserId) => {
      expect(isSelfTarget(currentUserId, targetUserId)).toBe(
        currentUserId === targetUserId
      );
    }
  );

  test.prop(
    [
      fc.record({
        currentUserId: nonBlankUserId,
        userId: nonBlankUserId,
        nextRole: fc.option(role, { nil: undefined }),
        currentRole: role,
      }),
    ],
    PROPERTY_DEFAULTS
  )(
    'allows generated role changes only for other users and new roles',
    (input) => {
      expect(canChangeRole(input)).toBe(
        input.currentUserId !== input.userId &&
          input.nextRole !== undefined &&
          input.nextRole !== input.currentRole
      );
    }
  );
});
