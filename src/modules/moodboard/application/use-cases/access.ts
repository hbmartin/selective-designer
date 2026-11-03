import { Result } from '@bloodyowl/boxed';

import type { DesignId, UserId } from '@/modules/kernel/domain/ids';

import type { MoodboardResult, MoodboardUseCaseDeps } from './types';

/**
 * The caller may act on the design's mood board: role permission plus
 * ownership of the design. Outcomes are tagged so use cases can map them.
 */
export const checkMoodboardAccess = async (
  deps: Pick<MoodboardUseCaseDeps, 'permissionChecker' | 'designAccess'>,
  input: {
    userId: UserId;
    designId: DesignId;
    action: 'read' | 'update';
  }
): Promise<
  MoodboardResult<
    | { type: 'allowed' }
    | { type: 'moodboard_forbidden' }
    | { type: 'design_not_found' }
  >
> => {
  const permission = await deps.permissionChecker.hasPermission(input.userId, {
    design: [input.action],
  });
  if (permission.isError()) return Result.Error(permission.getError());
  if (permission.get().type === 'permission_denied') {
    return Result.Ok({ type: 'moodboard_forbidden' });
  }
  const owned = await deps.designAccess.isOwnedBy({
    designId: input.designId,
    userId: input.userId,
  });
  if (owned.isError()) return Result.Error(owned.getError());
  return Result.Ok(
    owned.get().type === 'owned'
      ? { type: 'allowed' }
      : { type: 'design_not_found' }
  );
};
