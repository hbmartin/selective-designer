import { Result } from '@bloodyowl/boxed';

import type { DesignId, UserId } from '@/modules/kernel/domain/ids';

import { checkDesignPermission } from './design-access';
import { type DesignView, toDesignView } from './design-view';
import type {
  DesignForbiddenOutcome,
  DesignResult,
  DesignUseCaseDeps,
} from './types';

export type GetDesignInput = { currentUserId: UserId; id: DesignId };

export type DesignGetOutcome =
  | { type: 'design_found'; design: DesignView }
  | { type: 'design_not_found' }
  | DesignForbiddenOutcome;

export async function getDesign(
  deps: DesignUseCaseDeps,
  input: GetDesignInput
): Promise<DesignResult<DesignGetOutcome>> {
  const access = await checkDesignPermission(deps, input.currentUserId, 'read');
  if (access.isError()) return Result.Error(access.getError());
  if (access.get().type === 'forbidden') {
    return Result.Ok({ type: 'design_forbidden' });
  }

  const found = await deps.designRepository.findOwned({
    id: input.id,
    ownerId: input.currentUserId,
  });
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'design_not_found') return Result.Ok(outcome);

  const view = await toDesignView(deps, outcome.design);
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'design_found', design: view.get() });
}
