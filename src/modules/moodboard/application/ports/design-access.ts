import type { ApplicationResult } from '@/modules/kernel';
import type { DesignId, UserId } from '@/modules/kernel/domain/ids';

/** Ownership checks against the `design` module, injected by composition. */
export interface DesignAccess {
  isOwnedBy(input: {
    designId: DesignId;
    userId: UserId;
  }): Promise<ApplicationResult<{ type: 'owned' } | { type: 'not_owned' }>>;
  /** Pipeline: the design's owner, for attributing provider costs. */
  ownerOf(
    designId: DesignId
  ): Promise<
    ApplicationResult<{ type: 'owner'; userId: UserId } | { type: 'missing' }>
  >;
}
