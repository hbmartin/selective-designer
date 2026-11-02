import { Result } from '@bloodyowl/boxed';

import type { UserId } from '@/modules/kernel/domain/ids';

import type {
  AccountResult,
  AccountUpdateOutcome,
  AccountUseCaseDeps,
} from './types';
import { type AccountName, normalizeAccountName } from '../../domain/account';

export type UpdateAccountInfoInput = {
  currentUserId: UserId;
  name: AccountName;
};

export async function updateAccountInfo(
  deps: AccountUseCaseDeps,
  input: UpdateAccountInfoInput
): Promise<AccountResult<AccountUpdateOutcome>> {
  const allowed = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    { account: ['update'] }
  );
  if (allowed.isError()) return Result.Error(allowed.getError());
  if (allowed.get().type === 'permission_denied') {
    return Result.Ok({ type: 'account_forbidden' });
  }

  deps.logger.info({
    event: 'account.update_info',
    userId: input.currentUserId,
  });
  const result = await deps.accountRepository.updateInfo(input.currentUserId, {
    name: normalizeAccountName(input.name),
  });
  if (result.isError()) return Result.Error(result.getError());
  return Result.Ok(result.get());
}
