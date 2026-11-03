import { Result } from '@bloodyowl/boxed';

import {
  type DesignId,
  type ObjectKey,
  toImageId,
  type UserId,
} from '@/modules/kernel/domain/ids';
import { objectKeyMatchesPurpose } from '@/modules/kernel/domain/upload-policy';

import { checkDesignPermission } from './design-access';
import { type DesignImageView, toDesignImageView } from './design-view';
import type {
  DesignForbiddenOutcome,
  DesignResult,
  DesignUseCaseDeps,
} from './types';
import type { ImageDimensions } from '../../domain/design';
import {
  isConsistentWorkingCopy,
  isValidImageDimensions,
} from '../../domain/image-policy';

export type SourcePhotoListOutcome =
  | { type: 'source_photos_listed'; photos: DesignImageView[] }
  | { type: 'design_not_found' }
  | DesignForbiddenOutcome;

export type SourcePhotoAddOutcome =
  | { type: 'source_photo_added'; photo: DesignImageView }
  | { type: 'design_not_found' }
  | { type: 'design_upload_unowned' }
  | { type: 'design_image_invalid' }
  | DesignForbiddenOutcome;

const requireOwnedDesign = async (
  deps: DesignUseCaseDeps,
  input: {
    currentUserId: UserId;
    designId: DesignId;
    action: 'read' | 'update';
  }
): Promise<
  DesignResult<
    { type: 'ok' } | { type: 'design_not_found' } | DesignForbiddenOutcome
  >
> => {
  const access = await checkDesignPermission(
    deps,
    input.currentUserId,
    input.action
  );
  if (access.isError()) return Result.Error(access.getError());
  if (access.get().type === 'forbidden') {
    return Result.Ok({ type: 'design_forbidden' });
  }
  const found = await deps.designRepository.findOwned({
    id: input.designId,
    ownerId: input.currentUserId,
  });
  if (found.isError()) return Result.Error(found.getError());
  return Result.Ok(
    found.get().type === 'design_found'
      ? { type: 'ok' }
      : { type: 'design_not_found' }
  );
};

/** Room or product photos that items can be extracted from. */
export async function listSourcePhotos(
  deps: DesignUseCaseDeps,
  input: { currentUserId: UserId; designId: DesignId }
): Promise<DesignResult<SourcePhotoListOutcome>> {
  const owned = await requireOwnedDesign(deps, { ...input, action: 'read' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);

  const listed = await deps.designRepository.listImages({
    designId: input.designId,
    kind: 'source_photo',
  });
  if (listed.isError()) return Result.Error(listed.getError());
  const photos: DesignImageView[] = [];
  for (const image of listed.get().images) {
    // oxlint-disable-next-line no-await-in-loop -- signing is local HMAC.
    const view = await toDesignImageView(deps, image);
    if (view.isError()) return Result.Error(view.getError());
    photos.push(view.get());
  }
  return Result.Ok({ type: 'source_photos_listed', photos });
}

export async function addSourcePhoto(
  deps: DesignUseCaseDeps,
  input: {
    currentUserId: UserId;
    designId: DesignId;
    photo: {
      originalKey: ObjectKey;
      original: ImageDimensions;
      workingKey: ObjectKey;
      working: ImageDimensions;
    };
  }
): Promise<DesignResult<SourcePhotoAddOutcome>> {
  const owned = await requireOwnedDesign(deps, { ...input, action: 'update' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);

  const { photo } = input;
  if (
    !isValidImageDimensions(photo.original) ||
    !isValidImageDimensions(photo.working) ||
    !isConsistentWorkingCopy(photo) ||
    !objectKeyMatchesPurpose(photo.originalKey, 'source_photo') ||
    !objectKeyMatchesPurpose(photo.workingKey, 'working_image')
  ) {
    return Result.Ok({ type: 'design_image_invalid' });
  }

  const now = deps.clock.now();
  const original = await deps.uploadIntentStore.consume({
    objectKey: photo.originalKey,
    userId: input.currentUserId,
    purpose: 'source_photo',
    now,
  });
  if (original.isError()) return Result.Error(original.getError());
  const originalIntent = original.get();
  if (originalIntent.type === 'upload_intent_unowned') {
    return Result.Ok({ type: 'design_upload_unowned' });
  }
  const working = await deps.uploadIntentStore.consume({
    objectKey: photo.workingKey,
    userId: input.currentUserId,
    purpose: 'working_image',
    now,
  });
  if (working.isError()) return Result.Error(working.getError());
  if (working.get().type === 'upload_intent_unowned') {
    return Result.Ok({ type: 'design_upload_unowned' });
  }

  const rawId = deps.idGenerator.createId();
  if (rawId.isError()) return Result.Error(rawId.getError());
  const imageId = toImageId(rawId.get());
  if (imageId.isError()) return Result.Error(imageId.getError());
  const added = await deps.designRepository.addImage({
    designId: input.designId,
    image: {
      id: imageId.get(),
      kind: 'source_photo',
      originalKey: photo.originalKey,
      originalContentType: originalIntent.contentType,
      original: photo.original,
      workingKey: photo.workingKey,
      working: photo.working,
    },
  });
  if (added.isError()) return Result.Error(added.getError());
  const view = await toDesignImageView(deps, added.get().image);
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'source_photo_added', photo: view.get() });
}
