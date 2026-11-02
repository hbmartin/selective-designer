import { Result } from '@bloodyowl/boxed';
import { eq } from 'drizzle-orm';

import type {
  AccountOnboardingUpdate,
  AccountProfileUpdate,
  AccountRepository,
  AccountUpdateRepositoryOutcome,
} from '@/modules/account';
import {
  AppError,
  type ApplicationResult,
  type ParseResult,
  toUserId,
  type UserId,
} from '@/modules/kernel';
import { extractDatabaseErrorDetails } from '@/modules/kernel/infrastructure/db/errors';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

import { user as userTable } from './schema';

const isSqlStateCode = (code: unknown): code is string =>
  typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code);

function invalidAccountRowError(cause: unknown): AppError {
  return new AppError({
    code: 'ACCOUNT_ROW_INVALID',
    category: 'system',
    status: 500,
    message: 'Account row contains invalid data',
    cause,
  });
}

function parseAccountRowValue<TValue>(
  result: ParseResult<TValue>
): ApplicationResult<TValue> {
  return result.isError()
    ? Result.Error(invalidAccountRowError(result.getError()))
    : Result.Ok(result.get());
}

function mapDbError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const details = extractDatabaseErrorDetails(error);

  if (isSqlStateCode(details?.code)) {
    return new AppError({
      code: 'ACCOUNT_REPOSITORY_DB_ERROR',
      category: 'system',
      status: 500,
      message: 'Account repository database error',
      cause: error,
    });
  }

  return new AppError({
    code: 'ACCOUNT_REPOSITORY_ERROR',
    category: 'system',
    status: 500,
    message: 'Account repository error',
    cause: error,
  });
}

export class AccountRepositoryDrizzle implements AccountRepository {
  constructor(private readonly db: DbLike) {}

  private toAccountUpdatedResult(
    updatedUser: { id: string } | undefined
  ): ApplicationResult<AccountUpdateRepositoryOutcome> {
    if (!updatedUser) return Result.Ok({ type: 'account_not_found' });

    const id = parseAccountRowValue(toUserId(updatedUser.id));
    if (id.isError()) return Result.Error(id.getError());

    return Result.Ok({
      type: 'account_updated',
      account: { id: id.get() },
    });
  }

  async submitOnboarding(
    userId: UserId,
    input: AccountOnboardingUpdate
  ): ReturnType<AccountRepository['submitOnboarding']> {
    try {
      const [updatedUser] = await this.db
        .update(userTable)
        .set({
          name: input.name,
          onboardedAt: input.onboardedAt,
        })
        .where(eq(userTable.id, userId))
        .returning({ id: userTable.id });

      return this.toAccountUpdatedResult(updatedUser);
    } catch (error) {
      return Result.Error(mapDbError(error));
    }
  }

  async updateInfo(
    userId: UserId,
    input: AccountProfileUpdate
  ): ReturnType<AccountRepository['updateInfo']> {
    try {
      const [updatedUser] = await this.db
        .update(userTable)
        .set({ name: input.name })
        .where(eq(userTable.id, userId))
        .returning({ id: userTable.id });

      return this.toAccountUpdatedResult(updatedUser);
    } catch (error) {
      return Result.Error(mapDbError(error));
    }
  }
}

export interface AccountRepositoryDrizzleDependencies {
  db: DbLike;
}

export function createAccountRepository(
  dependencies: AccountRepositoryDrizzleDependencies
): AccountRepository {
  return observeRepository(
    new AccountRepositoryDrizzle(dependencies.db),
    'account'
  );
}
