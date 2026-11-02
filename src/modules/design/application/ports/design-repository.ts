import type { ApplicationResult } from '@/modules/kernel';
import type {
  DesignId,
  ImageId,
  ObjectKey,
  UserId,
} from '@/modules/kernel/domain/ids';

import type {
  Design,
  DesignImage,
  DesignImageKind,
  DesignListPage,
  DesignName,
  ImageDimensions,
} from '../../domain/design';

export type DesignListQuery = {
  ownerId: UserId;
  archived: boolean;
  searchTerm: string;
  cursor: DesignId | undefined;
  limit: number;
};

export type NewDesignImage = {
  id: ImageId;
  kind: DesignImageKind;
  originalKey: ObjectKey;
  originalContentType: string;
  original: ImageDimensions;
  workingKey: ObjectKey;
  working: ImageDimensions;
};

export type DesignListedOutcome = {
  type: 'design_listed';
  page: DesignListPage;
};
export type DesignFoundOutcome = { type: 'design_found'; design: Design };
export type DesignNotFoundOutcome = { type: 'design_not_found' };
export type DesignCreatedOutcome = { type: 'design_created'; design: Design };
export type DesignUpdatedOutcome = { type: 'design_updated'; design: Design };
export type ImageFoundOutcome = {
  type: 'image_found';
  image: DesignImage;
  designName: DesignName;
  ownerId: UserId;
};
export type ImageNotFoundOutcome = { type: 'image_not_found' };
export type ImageAddedOutcome = { type: 'image_added'; image: DesignImage };

/** Persistence for designs and the images that belong to them. */
export interface DesignRepository {
  list(query: DesignListQuery): Promise<ApplicationResult<DesignListedOutcome>>;
  /** A design visible to `ownerId`; other owners' designs are not found. */
  findOwned(input: {
    id: DesignId;
    ownerId: UserId;
  }): Promise<ApplicationResult<DesignFoundOutcome | DesignNotFoundOutcome>>;
  create(input: {
    id: DesignId;
    ownerId: UserId;
    name: DesignName;
    copiedFromDesignId: DesignId | null;
    baseImage: NewDesignImage;
  }): Promise<ApplicationResult<DesignCreatedOutcome>>;
  update(input: {
    id: DesignId;
    ownerId: UserId;
    changes: { name?: DesignName; archivedAt?: Date | null };
  }): Promise<ApplicationResult<DesignUpdatedOutcome | DesignNotFoundOutcome>>;
  /** Any image of the design, with the design's owner for access checks. */
  findImage(
    imageId: ImageId
  ): Promise<ApplicationResult<ImageFoundOutcome | ImageNotFoundOutcome>>;
  /** Pipeline: attach a render result or source photo to a design. */
  addImage(input: {
    designId: DesignId;
    image: NewDesignImage;
  }): Promise<ApplicationResult<ImageAddedOutcome>>;
}
