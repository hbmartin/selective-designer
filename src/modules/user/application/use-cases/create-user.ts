import { Result } from '@bloodyowl/boxed';

import type { UserId } from '@/modules/kernel/domain/ids';

import type { UserCreateOutcome, UserResult, UserUseCaseDeps } from './types';
import type { UserCreateInput } from '../../domain/user';
import { assignsPrivilegedRole } from '../../domain/user-policy';

export type CreateUserInput = {
  currentUserId: UserId;
  user: UserCreateInput;
};

export async function createUser(
  deps: UserUseCaseDeps,
  input: CreateUserInput
): Promise<UserResult<UserCreateOutcome>> {
  const allowed = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    { user: ['create'] }
  );
  if (allowed.isError()) return Result.Error(allowed.getError());
  if (allowed.get().type === 'permission_denied') {
    return Result.Ok({ type: 'user_forbidden' });
  }

  // Assigning a privileged (non-default) role at creation time is a privilege
  // assignment and must require the dedicated `user:set-role` permission — the
  // same gate updateUser enforces. Otherwise `user:create` alone could mint
  // admin accounts (CWE-269 / CWE-915).
  if (assignsPrivilegedRole(input.user.role)) {
    const canSetRole = await deps.permissionChecker.hasPermission(
      input.currentUserId,
      { user: ['set-role'] }
    );
    if (canSetRole.isError()) return Result.Error(canSetRole.getError());
    if (canSetRole.get().type === 'permission_denied') {
      return Result.Ok({ type: 'user_forbidden' });
    }
  }

  deps.logger.info({ event: 'user.create' });
  const result = await deps.userRepository.create(input.user);
  if (result.isError()) return Result.Error(result.getError());
  return Result.Ok(result.get());
}
