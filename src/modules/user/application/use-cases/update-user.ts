import { Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import type { UserId } from '@/modules/kernel';

import type { UserResult, UserUpdateOutcome, UserUseCaseDeps } from './types';
import type { UserUpdateInput } from '../../domain/user';
import { emptyUserDisplayName, shouldUnverifyEmail } from '../../domain/user';
import { canChangeRole } from '../../domain/user-policy';

export type UpdateUserInput = {
  currentUserId: UserId;
  id: UserId;
  user: UserUpdateInput;
};

export async function updateUser(
  deps: UserUseCaseDeps,
  input: UpdateUserInput
): Promise<UserResult<UserUpdateOutcome>> {
  const allowed = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    { user: ['update'] }
  );
  const permissionResult = match(allowed)
    .with(Result.P.Error(P.select()), (error) => Result.Error(error))
    .with(Result.P.Ok({ type: 'permission_denied' }), () =>
      Result.Ok({ type: 'user_forbidden' as const })
    )
    .with(Result.P.Ok({ type: 'permission_granted' }), () => undefined)
    .exhaustive();
  if (permissionResult !== undefined) return permissionResult;

  const currentResult = await deps.userRepository.getUpdateSnapshot(input.id);
  const currentResultBranch = match(currentResult)
    .with(Result.P.Error(P.select()), (error) => ({
      result: Result.Error(error),
      type: 'return' as const,
    }))
    .with(Result.P.Ok({ type: 'user_not_found' }), () => ({
      result: Result.Ok({ type: 'user_not_found' as const }),
      type: 'return' as const,
    }))
    .with(
      Result.P.Ok({
        snapshot: P.select(),
        type: 'user_update_snapshot_found',
      }),
      (snapshot) => ({
        snapshot,
        type: 'continue' as const,
      })
    )
    .exhaustive();
  if (currentResultBranch.type === 'return') return currentResultBranch.result;
  const current = currentResultBranch.snapshot;

  const submittedRole = input.user.role ?? undefined;
  const nextRole = canChangeRole({
    currentUserId: input.currentUserId,
    userId: input.id,
    nextRole: submittedRole,
    currentRole: current.role,
  })
    ? submittedRole
    : undefined;

  const roleWriteRequested = nextRole !== undefined;

  if (roleWriteRequested) {
    const canSetRole = await deps.permissionChecker.hasPermission(
      input.currentUserId,
      { user: ['set-role'] }
    );
    const setRolePermissionResult = match(canSetRole)
      .with(Result.P.Error(P.select()), (error) => Result.Error(error))
      .with(Result.P.Ok({ type: 'permission_denied' }), () =>
        Result.Ok({ type: 'user_forbidden' as const })
      )
      .with(Result.P.Ok({ type: 'permission_granted' }), () => undefined)
      .exhaustive();
    if (setRolePermissionResult !== undefined) return setRolePermissionResult;
  }

  deps.logger.info({
    event: 'user.update',
    details: { userId: input.id },
  });
  const update = {
    email: input.user.email,
    role: nextRole,
    emailVerified: shouldUnverifyEmail(current.email, input.user.email)
      ? false
      : undefined,
    ...(input.user.name === undefined
      ? {}
      : { name: input.user.name ?? emptyUserDisplayName }),
  };
  const result = await deps.userRepository.update(input.id, {
    ...update,
  });
  if (result.isError()) return Result.Error(result.getError());
  const updated = result.get();

  // A privilege write must evict the target's existing sessions. The session
  // store caches the user's role/ban snapshot at sign-in time, so without an
  // explicit revoke a retried role write can leave stale sessions presenting
  // the previous role until expiry. Revoking forces re-authentication, which
  // mints a fresh session carrying the current role. (CWE-613 / CWE-269.)
  if (roleWriteRequested && updated.type === 'user_updated') {
    const revoked = await deps.userAuthGateway.revokeUserSessions(input.id);
    if (revoked.isError()) return Result.Error(revoked.getError());
    deps.logger.warn({
      event: 'security.session_revoked',
      details: {
        mode: 'all',
        reason: 'role_changed',
        revokedByUserId: input.currentUserId,
        targetUserId: input.id,
      },
    });
  }

  return Result.Ok(updated);
}
