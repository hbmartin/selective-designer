import { testAccountName } from '@tests/support/branded-values';
import { describe, expect, it } from 'vitest';

import { createAccountRepository } from '@/modules/auth/infrastructure/drizzle/account-repository-drizzle';
import { toUserId } from '@/modules/kernel/domain/ids';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';
import type { ApplicationResult } from '@/modules/kernel/testing';
import { unwrapParseResult } from '@/modules/kernel/testing';

function makeThrowingDb(error: unknown): DbLike {
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            throw error;
          },
        }),
      }),
    }),
  } as unknown as DbLike;
}

function makeReturningDb(row: { id: string } | undefined): DbLike {
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => (row ? [row] : []),
        }),
      }),
    }),
  } as unknown as DbLike;
}

function getError<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isOk()) {
    throw new Error(`Expected Result.Error, got ${result.get().type}`);
  }
  return result.getError();
}

describe('AccountRepositoryDrizzle', () => {
  it('maps wrapped database errors to account repository database errors', async () => {
    const databaseError = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'user_email_key',
      severity: 'ERROR',
    });
    const wrappedError = new Error('Failed query');
    wrappedError.cause = databaseError;

    const repository = createAccountRepository({
      db: makeThrowingDb(wrappedError),
    });

    const result = await repository.submitOnboarding(
      unwrapParseResult(toUserId('user-1')),
      {
        name: testAccountName('User'),
        onboardedAt: new Date('2026-01-01T00:00:00.000Z'),
      }
    );

    expect(getError(result)).toMatchObject({
      code: 'ACCOUNT_REPOSITORY_DB_ERROR',
      cause: wrappedError,
    });
  });

  it('maps invalid persisted account rows to a system row error', async () => {
    const repository = createAccountRepository({
      db: makeReturningDb({ id: '' }),
    });

    const result = await repository.updateInfo(
      unwrapParseResult(toUserId('user-1')),
      {
        name: testAccountName('User'),
      }
    );

    expect(getError(result)).toMatchObject({
      code: 'ACCOUNT_ROW_INVALID',
      category: 'system',
      status: 500,
    });
  });

  it('maps invalid persisted onboarding rows to a system row error', async () => {
    const repository = createAccountRepository({
      db: makeReturningDb({ id: '' }),
    });

    const result = await repository.submitOnboarding(
      unwrapParseResult(toUserId('user-1')),
      {
        name: testAccountName('User'),
        onboardedAt: new Date('2026-01-01T00:00:00.000Z'),
      }
    );

    expect(getError(result)).toMatchObject({
      code: 'ACCOUNT_ROW_INVALID',
      category: 'system',
      status: 500,
    });
  });
});
