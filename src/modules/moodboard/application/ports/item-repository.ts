import type { ApplicationResult } from '@/modules/kernel';
import type {
  DesignId,
  ItemId,
  ItemVersionId,
  ObjectKey,
  UserId,
} from '@/modules/kernel/domain/ids';

import type { CutoutOutputCheckpoint } from '../../domain/cutout-output';
import type {
  CutoutStatus,
  Item,
  ItemCategory,
  ItemKind,
  ItemName,
  ItemVersion,
  PhotoInfo,
} from '../../domain/item';

export type NewItemVersion = {
  id: ItemVersionId;
  photo: PhotoInfo;
  cutoutKey: ObjectKey | null;
  maskKey: ObjectKey | null;
  cutoutStatus: CutoutStatus;
  cutoutAttempt?: { id: string; startedAt: Date };
};

export type ItemChanges = {
  name?: ItemName;
  category?: ItemCategory;
  vendor?: string | null;
  productUrl?: string | null;
};

export type ItemFound = { type: 'item_found'; item: Item };
export type ItemNotFound = { type: 'item_not_found' };
export type VersionFound = {
  type: 'item_version_found';
  version: ItemVersion;
  cutoutAttemptId: string | null;
  cutoutOutput: CutoutOutputCheckpoint | null;
  designId: DesignId;
};
export type VersionNotFound = { type: 'item_version_not_found' };

export interface ItemRepository {
  /** Items of a design that have not been removed, oldest first. */
  listByDesign(
    designId: DesignId
  ): Promise<ApplicationResult<{ type: 'items_listed'; items: Item[] }>>;
  findInDesign(input: {
    itemId: ItemId;
    designId: DesignId;
  }): Promise<ApplicationResult<ItemFound | ItemNotFound>>;
  /** Any item, regardless of design (ownership is checked by the caller). */
  findById(
    itemId: ItemId
  ): Promise<ApplicationResult<ItemFound | ItemNotFound>>;
  create(input: {
    id: ItemId;
    designId: DesignId;
    kind: ItemKind;
    name: ItemName;
    category: ItemCategory;
    vendor: string | null;
    productUrl: string | null;
    version: NewItemVersion;
  }): Promise<ApplicationResult<{ type: 'item_created'; item: Item }>>;
  update(input: {
    itemId: ItemId;
    changes: ItemChanges;
  }): Promise<ApplicationResult<ItemFound | ItemNotFound>>;
  /** Append a version and make it the item's current version. */
  addVersion(input: {
    itemId: ItemId;
    version: NewItemVersion;
  }): Promise<ApplicationResult<ItemFound | ItemNotFound>>;
  remove(input: {
    itemId: ItemId;
    removedAt: Date;
  }): Promise<ApplicationResult<{ type: 'item_removed' } | ItemNotFound>>;
  findVersion(
    versionId: ItemVersionId
  ): Promise<ApplicationResult<VersionFound | VersionNotFound>>;
  claimCutoutAttempt(input: {
    versionId: ItemVersionId;
    attemptId: string;
    startedAt: Date;
    expiredBeforeMs: number;
  }): Promise<
    ApplicationResult<
      { type: 'cutout_attempt_claimed' } | { type: 'cutout_attempt_skipped' }
    >
  >;
  saveCutoutOutput(input: {
    versionId: ItemVersionId;
    attemptId: string;
    checkpoint: CutoutOutputCheckpoint;
  }): Promise<
    ApplicationResult<
      | { type: 'cutout_output_saved'; checkpoint: CutoutOutputCheckpoint }
      | { type: 'cutout_attempt_skipped' }
    >
  >;
  finishCutoutAttempt(
    input: { versionId: ItemVersionId; attemptId: string | null } & (
      | { cutoutStatus: 'ready'; cutoutKey: ObjectKey }
      | { cutoutStatus: 'failed'; cutoutKey: null }
    )
  ): Promise<
    ApplicationResult<
      { type: 'cutout_result_saved' } | { type: 'cutout_attempt_skipped' }
    >
  >;
  checkAbandonedCutout(input: {
    versionId: ItemVersionId;
    attemptId: string | null;
    cutoutKey: ObjectKey;
  }): Promise<
    ApplicationResult<
      { type: 'cutout_object_abandoned' } | { type: 'cutout_object_in_use' }
    >
  >;
  /** How often the owner used each category across their designs. */
  categoryUsage(ownerId: UserId): Promise<
    ApplicationResult<{
      type: 'category_usage';
      usage: { category: string; count: number }[];
    }>
  >;
}
