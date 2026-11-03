import type { ApplicationResult } from '@/modules/kernel';
import type { DesignId, ImageId } from '@/modules/kernel/domain/ids';

/**
 * Notified when a design is created from a revised architect image, so the
 * mood board and placements can be copied from the earlier design.
 */
export interface DesignCopiedListener {
  designCopied(input: {
    fromDesignId: DesignId;
    toDesignId: DesignId;
    toBaseImageId: ImageId;
  }): Promise<ApplicationResult<{ type: 'design_copy_handled' }>>;
}
