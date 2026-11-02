import { Result } from '@bloodyowl/boxed';

import type { DesignId, UserId } from '@/modules/kernel/domain/ids';

import { checkDesignPermission } from './design-access';
import { type DesignView, toDesignView } from './design-view';
import type {
  DesignForbiddenOutcome,
  DesignResult,
  DesignUseCaseDeps,
} from './types';
import type { DesignName } from '../../domain/design';

export type UpdateDesignInput = {
  currentUserId: UserId;
  id: DesignId;
  change:
    | { type: 'rename'; name: DesignName }
    | { type: 'archive' }
    | { type: 'unarchive' };
};

export type DesignUpdateOutcome =
  | { type: 'design_updated'; design: DesignView }
  | { type: 'design_not_found' }
  | DesignForbiddenOutcome;

/** Rename, archive or restore a design. Archiving keeps everything. */
export async function updateDesign(
  deps: DesignUseCaseDeps,
  input: UpdateDesignInput
): Promise<DesignResult<DesignUpdateOutcome>> {
  const access = await checkDesignPermission(
    deps,
    input.currentUserId,
    'update'
  );
  if (access.isError()) return Result.Error(access.getError());
  if (access.get().type === 'forbidden') {
    return Result.Ok({ type: 'design_forbidden' });
  }

  const changes =
    input.change.type === 'rename'
      ? { name: input.change.name }
      : {
          archivedAt: input.change.type === 'archive' ? deps.clock.now() : null,
        };

  deps.logger.info({
    event: 'design.update',
    details: { change: input.change.type },
  });
  const updated = await deps.designRepository.update({
    id: input.id,
    ownerId: input.currentUserId,
    changes,
  });
  if (updated.isError()) return Result.Error(updated.getError());
  const outcome = updated.get();
  if (outcome.type === 'design_not_found') return Result.Ok(outcome);

  const view = await toDesignView(deps, outcome.design);
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'design_updated', design: view.get() });
}
