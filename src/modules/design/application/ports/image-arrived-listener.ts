import type { ApplicationResult } from '@/modules/kernel';
import type { DesignId, ImageId } from '@/modules/kernel/domain/ids';

import type { DesignImageKind } from '../../domain/design';

/**
 * Notified when a base image or render result is stored, so other
 * capabilities (eager segmentation) can start work. Wired by composition.
 */
export interface ImageArrivedListener {
  imageArrived(input: {
    designId: DesignId;
    imageId: ImageId;
    kind: DesignImageKind;
    /** The render source a result was continued from, for region carry-over. */
    carryFromImageId: ImageId | null;
  }): Promise<ApplicationResult<{ type: 'image_arrival_handled' }>>;
}
