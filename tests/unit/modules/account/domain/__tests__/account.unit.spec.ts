import { testAccountName } from '@tests/support/branded-values';
import { describe, expect, it } from 'vitest';

import {
  normalizeAccountName,
  toAccountName,
} from '@/modules/account/domain/account';
import { ACCOUNT_NAME_MAX_LENGTH } from '@/modules/account/domain/account-policy';

describe('account domain', () => {
  it('normalizes parsed account names', () => {
    expect(normalizeAccountName(testAccountName(' Harold '))).toBe('Harold');
  });

  it('parses valid account names and rejects invalid names', () => {
    expect(toAccountName(' Harold ').isOk()).toBe(true);
    expect(toAccountName(' ').isError()).toBe(true);
    expect(
      toAccountName('a'.repeat(ACCOUNT_NAME_MAX_LENGTH + 1)).isError()
    ).toBe(true);
  });

  it('redacts invalid account name values from error details', () => {
    const result = toAccountName('Sensitive Account Name'.repeat(20));
    const error = result.match({
      Ok: () => {
        throw new Error('Expected parser to fail.');
      },
      Error: (value) => value,
    });

    expect(error.details).toMatchObject({
      typeName: 'AccountName',
      value: '<redacted>',
    });
  });
});
