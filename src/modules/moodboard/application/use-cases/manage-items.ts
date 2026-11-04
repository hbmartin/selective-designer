import { Result } from '@bloodyowl/boxed';

import {
  type DesignId,
  type ItemId,
  type ObjectKey,
  toItemId,
  toItemVersionId,
  type UserId,
} from '@/modules/kernel/domain/ids';
import { objectKeyMatchesPurpose } from '@/modules/kernel/domain/upload-policy';

import { checkMoodboardAccess } from './access';
import { cutoutRetryCutoff, isCutoutRetryable } from './cutout-retry-policy';
import { type ItemView, toItemView } from './item-view';
import { scheduleCutoutAttempt } from './schedule-cutout-attempt';
import type {
  MoodboardDesignNotFound,
  MoodboardForbidden,
  MoodboardResult,
  MoodboardUseCaseDeps,
} from './types';
import type { ItemChanges, NewItemVersion } from '../ports/item-repository';
import {
  categorySuggestions,
  initialCutoutStatus,
  type Item,
  type ItemCategory,
  type ItemKind,
  type ItemName,
} from '../../domain/item';

const MAX_PHOTO_EDGE = 20_000;

export type UploadedPhoto = { key: ObjectKey; width: number; height: number };

const isValidPhoto = (photo: UploadedPhoto) =>
  Number.isInteger(photo.width) &&
  Number.isInteger(photo.height) &&
  photo.width > 0 &&
  photo.height > 0 &&
  photo.width <= MAX_PHOTO_EDGE &&
  photo.height <= MAX_PHOTO_EDGE &&
  objectKeyMatchesPurpose(photo.key, 'item_photo');

const newVersionId = (deps: MoodboardUseCaseDeps) => {
  const raw = deps.idGenerator.createId();
  if (raw.isError()) return Result.Error(raw.getError());
  return toItemVersionId(raw.get());
};

export type ListMoodboardOutcome =
  | { type: 'moodboard_listed'; items: ItemView[] }
  | MoodboardForbidden
  | MoodboardDesignNotFound;

export async function listMoodboard(
  deps: MoodboardUseCaseDeps,
  input: { currentUserId: UserId; designId: DesignId }
): Promise<MoodboardResult<ListMoodboardOutcome>> {
  const access = await checkMoodboardAccess(deps, {
    userId: input.currentUserId,
    designId: input.designId,
    action: 'read',
  });
  if (access.isError()) return Result.Error(access.getError());
  if (access.get().type !== 'allowed') {
    return Result.Ok(
      access.get() as MoodboardForbidden | MoodboardDesignNotFound
    );
  }
  const listed = await deps.itemRepository.listByDesign(input.designId);
  if (listed.isError()) return Result.Error(listed.getError());
  const items: ItemView[] = [];
  for (const item of listed.get().items) {
    // oxlint-disable-next-line no-await-in-loop -- signing is local HMAC.
    const view = await toItemView(deps, item);
    if (view.isError()) return Result.Error(view.getError());
    items.push(view.get());
  }
  return Result.Ok({ type: 'moodboard_listed', items });
}

export type CreateItemOutcome =
  | { type: 'item_created'; item: ItemView }
  | { type: 'item_upload_unowned' }
  | { type: 'item_photo_invalid' }
  | MoodboardForbidden
  | MoodboardDesignNotFound;

export async function createItem(
  deps: MoodboardUseCaseDeps,
  input: {
    currentUserId: UserId;
    designId: DesignId;
    kind: ItemKind;
    name: ItemName;
    category: ItemCategory;
    vendor: string | null;
    productUrl: string | null;
    photo: UploadedPhoto;
  }
): Promise<MoodboardResult<CreateItemOutcome>> {
  const access = await checkMoodboardAccess(deps, {
    userId: input.currentUserId,
    designId: input.designId,
    action: 'update',
  });
  if (access.isError()) return Result.Error(access.getError());
  if (access.get().type !== 'allowed') {
    return Result.Ok(
      access.get() as MoodboardForbidden | MoodboardDesignNotFound
    );
  }
  if (!isValidPhoto(input.photo))
    return Result.Ok({ type: 'item_photo_invalid' });

  const consumed = await deps.uploadIntentStore.consume({
    objectKey: input.photo.key,
    userId: input.currentUserId,
    purpose: 'item_photo',
    now: deps.clock.now(),
  });
  if (consumed.isError()) return Result.Error(consumed.getError());
  const intent = consumed.get();
  if (intent.type === 'upload_intent_unowned') {
    return Result.Ok({ type: 'item_upload_unowned' });
  }

  const rawItemId = deps.idGenerator.createId();
  if (rawItemId.isError()) return Result.Error(rawItemId.getError());
  const itemId = toItemId(rawItemId.get());
  if (itemId.isError()) return Result.Error(itemId.getError());
  const versionId = newVersionId(deps);
  if (versionId.isError()) return Result.Error(versionId.getError());

  const cutoutStatus = initialCutoutStatus(input.kind);
  let attemptId: string | undefined;
  if (cutoutStatus === 'pending') {
    const attempt = deps.idGenerator.createId();
    if (attempt.isError()) return Result.Error(attempt.getError());
    attemptId = attempt.get();
  }
  const version: NewItemVersion = {
    id: versionId.get(),
    photo: {
      key: input.photo.key,
      contentType: intent.contentType,
      width: input.photo.width,
      height: input.photo.height,
    },
    cutoutKey: null,
    maskKey: null,
    cutoutStatus,
    ...(attemptId
      ? { cutoutAttempt: { id: attemptId, startedAt: deps.clock.now() } }
      : {}),
  };
  const created = await deps.itemRepository.create({
    id: itemId.get(),
    designId: input.designId,
    kind: input.kind,
    name: input.name,
    category: input.category,
    vendor: input.vendor,
    productUrl: input.productUrl,
    version,
  });
  if (created.isError()) return Result.Error(created.getError());
  deps.logger.info({
    event: 'moodboard.item.create',
    details: { kind: input.kind },
  });

  if (attemptId) {
    const scheduled = await scheduleCutoutAttempt(
      deps,
      { itemVersionId: version.id, attemptId },
      'report_error'
    );
    if (scheduled.isError()) return Result.Error(scheduled.getError());
  }

  const view = await toItemView(deps, created.get().item);
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'item_created', item: view.get() });
}

type ItemMutationOutcome =
  | { type: 'item_updated'; item: ItemView }
  | { type: 'item_not_found' }
  | MoodboardForbidden
  | MoodboardDesignNotFound;

type OwnedItemOutcome =
  | { type: 'item_found'; item: Item }
  | { type: 'item_not_found' }
  | MoodboardForbidden;

const loadOwnedItem = async (
  deps: MoodboardUseCaseDeps,
  input: { currentUserId: UserId; itemId: ItemId }
): Promise<MoodboardResult<OwnedItemOutcome>> => {
  const found = await deps.itemRepository.findById(input.itemId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'item_not_found') {
    return Result.Ok({ type: 'item_not_found' });
  }
  const access = await checkMoodboardAccess(deps, {
    userId: input.currentUserId,
    designId: outcome.item.designId,
    action: 'update',
  });
  if (access.isError()) return Result.Error(access.getError());
  const accessOutcome = access.get();
  if (accessOutcome.type === 'design_not_found') {
    return Result.Ok({ type: 'item_not_found' });
  }
  if (accessOutcome.type === 'moodboard_forbidden') {
    return Result.Ok(accessOutcome);
  }
  return Result.Ok({ type: 'item_found', item: outcome.item });
};

const toUpdated = async (
  deps: MoodboardUseCaseDeps,
  found: Awaited<ReturnType<MoodboardUseCaseDeps['itemRepository']['update']>>
): Promise<MoodboardResult<ItemMutationOutcome>> => {
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'item_not_found') return Result.Ok(outcome);
  const view = await toItemView(deps, outcome.item);
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'item_updated', item: view.get() });
};

export async function updateItem(
  deps: MoodboardUseCaseDeps,
  input: { currentUserId: UserId; itemId: ItemId; changes: ItemChanges }
): Promise<MoodboardResult<ItemMutationOutcome>> {
  const owned = await loadOwnedItem(deps, input);
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'item_found') return Result.Ok(ownedOutcome);
  return toUpdated(
    deps,
    await deps.itemRepository.update({
      itemId: input.itemId,
      changes: input.changes,
    })
  );
}

export type RemoveItemOutcome =
  | { type: 'item_removed' }
  | { type: 'item_not_found' }
  | MoodboardForbidden;

export async function removeItem(
  deps: MoodboardUseCaseDeps,
  input: { currentUserId: UserId; itemId: ItemId }
): Promise<MoodboardResult<RemoveItemOutcome>> {
  const owned = await loadOwnedItem(deps, input);
  if (owned.isError()) return Result.Error(owned.getError());
  const outcome = owned.get();
  if (outcome.type !== 'item_found') return Result.Ok(outcome);
  const removed = await deps.itemRepository.remove({
    itemId: input.itemId,
    removedAt: deps.clock.now(),
  });
  if (removed.isError()) return Result.Error(removed.getError());
  return Result.Ok(removed.get());
}

/**
 * Save a hand-corrected cut-out (erase/restore brush) as a new version. The
 * photo stays the same; earlier versions remain for recipes that used them.
 */
export async function correctCutout(
  deps: MoodboardUseCaseDeps,
  input: {
    currentUserId: UserId;
    itemId: ItemId;
    cutoutKey: ObjectKey;
    maskKey: ObjectKey;
  }
): Promise<
  MoodboardResult<ItemMutationOutcome | { type: 'item_upload_unowned' }>
> {
  const owned = await loadOwnedItem(deps, input);
  if (owned.isError()) return Result.Error(owned.getError());
  const outcome = owned.get();
  if (outcome.type !== 'item_found') return Result.Ok(outcome);

  const now = deps.clock.now();
  for (const [key, purpose] of [
    [input.cutoutKey, 'item_cutout'],
    [input.maskKey, 'item_mask'],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- two sequential intent checks.
    const consumed = await deps.uploadIntentStore.consume({
      objectKey: key,
      userId: input.currentUserId,
      purpose,
      now,
    });
    if (consumed.isError()) return Result.Error(consumed.getError());
    if (consumed.get().type === 'upload_intent_unowned') {
      return Result.Ok({ type: 'item_upload_unowned' });
    }
  }

  const versionId = newVersionId(deps);
  if (versionId.isError()) return Result.Error(versionId.getError());
  return toUpdated(
    deps,
    await deps.itemRepository.addVersion({
      itemId: input.itemId,
      version: {
        id: versionId.get(),
        photo: outcome.item.currentVersion.photo,
        cutoutKey: input.cutoutKey,
        maskKey: input.maskKey,
        cutoutStatus: 'ready',
      },
    })
  );
}

/** Re-run background removal for a failed or expired cut-out attempt. */
export async function retryCutout(
  deps: MoodboardUseCaseDeps,
  input: { currentUserId: UserId; itemId: ItemId }
): Promise<
  MoodboardResult<ItemMutationOutcome | { type: 'cutout_not_retryable' }>
> {
  const owned = await loadOwnedItem(deps, input);
  if (owned.isError()) return Result.Error(owned.getError());
  const outcome = owned.get();
  if (outcome.type !== 'item_found') return Result.Ok(outcome);
  const version = outcome.item.currentVersion;
  const startedAt = deps.clock.now();
  const expiredBeforeMs = cutoutRetryCutoff(startedAt);
  if (!isCutoutRetryable(version, expiredBeforeMs)) {
    return Result.Ok({ type: 'cutout_not_retryable' });
  }
  const attempt = deps.idGenerator.createId();
  if (attempt.isError()) return Result.Error(attempt.getError());
  const attemptId = attempt.get();
  const claimed = await deps.itemRepository.claimCutoutAttempt({
    versionId: version.id,
    attemptId,
    startedAt,
    expiredBeforeMs,
  });
  if (claimed.isError()) return Result.Error(claimed.getError());
  if (claimed.get().type === 'cutout_attempt_skipped') {
    return Result.Ok({ type: 'cutout_not_retryable' });
  }
  const scheduled = await scheduleCutoutAttempt(
    deps,
    { itemVersionId: version.id, attemptId },
    'report_error'
  );
  if (scheduled.isError()) return Result.Error(scheduled.getError());
  return toUpdated(deps, await deps.itemRepository.findById(input.itemId));
}

export async function suggestCategories(
  deps: MoodboardUseCaseDeps,
  input: { currentUserId: UserId }
): Promise<
  MoodboardResult<{ type: 'category_suggestions'; categories: string[] }>
> {
  const usage = await deps.itemRepository.categoryUsage(input.currentUserId);
  if (usage.isError()) return Result.Error(usage.getError());
  return Result.Ok({
    type: 'category_suggestions',
    categories: categorySuggestions(usage.get().usage),
  });
}
