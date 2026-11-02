import { describe, expect, it } from 'vitest';

import { ACCOUNT_NAME_MAX_LENGTH } from '@/modules/account';
import { zFormFieldsOnboarding } from '@/modules/auth/presentation/schema';

describe('auth presentation schema', () => {
  it('enforces the account name length bound during onboarding', () => {
    expect(
      zFormFieldsOnboarding().safeParse({
        name: 'a'.repeat(ACCOUNT_NAME_MAX_LENGTH + 1),
      }).success
    ).toBe(false);
  });
});
