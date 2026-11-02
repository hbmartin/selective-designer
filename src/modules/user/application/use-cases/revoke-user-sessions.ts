import { Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import type { UserId } from '@/modules/kernel/domain/ids';

import type {
  UserResult,
  UserRevokeSessionsOutcome,
  UserUseCaseDeps,
} from './types';
import { isSelfTarget } from '../../domain/user-policy';

export type RevokeUserSessionsInput = {
  currentUserId: UserId;
  id: UserId;
};

export async function revokeUserSessions(
  deps: UserUseCaseDeps,
  input: RevokeUserSessionsInput
): Promise<UserResult<UserRevokeSessionsOutcome>> {
  const allowed = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    { session: ['revoke'] }
  );
  const permissionResult = match(allowed)
    .with(Result.P.Error(P.select()), (error) => Result.Error(error))
    .with(Result.P.Ok({ type: 'permission_denied' }), () =>
      Result.Ok({ type: 'user_forbidden' as const })
    )
    .with(Result.P.Ok({ type: 'permission_granted' }), () => undefined)
    .exhaustive();
  if (permissionResult !== undefined) return permissionResult;
  if (isSelfTarget(input.currentUserId, input.id)) {
    return Result.Ok({ type: 'user_self' });
  }

  const result = await deps.userAuthGateway.revokeUserSessions(input.id);
  if (result.isError()) return Result.Error(result.getError());
  deps.logger.warn({
    details: {
      mode: 'all',
      revokedByUserId: input.currentUserId,
      targetUserId: input.id,
    },
    event: 'security.session_revoked',
  });
  return Result.Ok({ type: 'user_sessions_revoked' });
}
