import { Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import type { SessionId, UserId } from '@/modules/kernel/domain/ids';

import type {
  UserResult,
  UserRevokeSessionOutcome,
  UserUseCaseDeps,
} from './types';

export type RevokeUserSessionInput = {
  currentUserId: UserId;
  currentSessionId: SessionId;
  id: UserId;
  sessionId: SessionId;
};

export async function revokeUserSession(
  deps: UserUseCaseDeps,
  input: RevokeUserSessionInput
): Promise<UserResult<UserRevokeSessionOutcome>> {
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

  const targetResult = await deps.userRepository.findSessionForRevocation({
    userId: input.id,
    sessionId: input.sessionId,
  });
  const targetResultBranch = match(targetResult)
    .with(Result.P.Error(P.select()), (error) => ({
      result: Result.Error(error),
      type: 'return' as const,
    }))
    .with(Result.P.Ok({ type: 'user_session_not_found' }), () => ({
      result: Result.Ok({ type: 'user_session_not_found' as const }),
      type: 'return' as const,
    }))
    .with(
      Result.P.Ok({
        target: P.select(),
        type: 'user_session_revocation_target_found',
      }),
      (target) => ({
        target,
        type: 'continue' as const,
      })
    )
    .exhaustive();
  if (targetResultBranch.type === 'return') return targetResultBranch.result;
  const targetSession = targetResultBranch.target;
  if (input.currentSessionId === targetSession.id) {
    return Result.Ok({ type: 'user_self' });
  }

  const result = await deps.userAuthGateway.revokeUserSession({
    userId: input.id,
    sessionId: targetSession.id,
  });
  if (result.isError()) return Result.Error(result.getError());
  deps.logger.warn({
    details: {
      mode: 'single',
      targetUserId: input.id,
    },
    event: 'security.session_revoked',
  });
  return Result.Ok({ type: 'user_session_revoked' });
}
