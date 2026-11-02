import { Result } from '@bloodyowl/boxed';

import type { DesignId, UserId } from '@/modules/kernel/domain/ids';

import { checkDesignPermission } from './design-access';
import { type DesignView, toDesignView } from './design-view';
import type {
  DesignForbiddenOutcome,
  DesignResult,
  DesignUseCaseDeps,
} from './types';

export type ListDesignsInput = {
  currentUserId: UserId;
  archived: boolean;
  searchTerm: string;
  cursor: DesignId | undefined;
  limit: number;
};

export type DesignViewPage = {
  items: DesignView[];
  nextCursor: DesignId | undefined;
  total: number;
};

export type DesignListOutcome =
  | { type: 'design_listed'; page: DesignViewPage }
  | DesignForbiddenOutcome;

export async function listDesigns(
  deps: DesignUseCaseDeps,
  input: ListDesignsInput
): Promise<DesignResult<DesignListOutcome>> {
  const access = await checkDesignPermission(deps, input.currentUserId, 'read');
  if (access.isError()) return Result.Error(access.getError());
  if (access.get().type === 'forbidden') {
    return Result.Ok({ type: 'design_forbidden' });
  }

  const listed = await deps.designRepository.list({
    ownerId: input.currentUserId,
    archived: input.archived,
    searchTerm: input.searchTerm,
    cursor: input.cursor,
    limit: input.limit,
  });
  if (listed.isError()) return Result.Error(listed.getError());

  const { page } = listed.get();
  const items: DesignView[] = [];
  for (const design of page.items) {
    // oxlint-disable-next-line no-await-in-loop -- signing is local HMAC, not I/O.
    const view = await toDesignView(deps, design);
    if (view.isError()) return Result.Error(view.getError());
    items.push(view.get());
  }
  return Result.Ok({
    type: 'design_listed',
    page: { items, nextCursor: page.nextCursor, total: page.total },
  });
}
