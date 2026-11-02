import { Result } from '@bloodyowl/boxed';

import type { UserId } from '@/modules/kernel/domain/ids';

import type { DesignResult, DesignUseCaseDeps } from './types';

type DesignAction = 'read' | 'create' | 'update' | 'delete';

/** Role-level check; ownership is enforced separately by repository queries. */
export const checkDesignPermission = async (
  deps: Pick<DesignUseCaseDeps, 'permissionChecker'>,
  userId: UserId,
  action: DesignAction
): Promise<DesignResult<{ type: 'allowed' } | { type: 'forbidden' }>> => {
  const allowed = await deps.permissionChecker.hasPermission(userId, {
    design: [action],
  });
  if (allowed.isError()) return Result.Error(allowed.getError());
  return Result.Ok(
    allowed.get().type === 'permission_granted'
      ? { type: 'allowed' }
      : { type: 'forbidden' }
  );
};
