import { Result } from '@bloodyowl/boxed';

import {
  type DesignId,
  type ImageId,
  type ObjectKey,
  toDesignId,
  toImageId,
  type UserId,
} from '@/modules/kernel/domain/ids';
import { objectKeyMatchesPurpose } from '@/modules/kernel/domain/upload-policy';

import { checkDesignPermission } from './design-access';
import { type DesignView, toDesignView } from './design-view';
import type {
  DesignForbiddenOutcome,
  DesignResult,
  DesignUseCaseDeps,
} from './types';
import type { DesignName, ImageDimensions } from '../../domain/design';
import {
  isConsistentWorkingCopy,
  isValidImageDimensions,
} from '../../domain/image-policy';

/** A base image the browser uploaded: the original plus its working copy. */
export type UploadedBaseImage = {
  originalKey: ObjectKey;
  original: ImageDimensions;
  workingKey: ObjectKey;
  working: ImageDimensions;
};

export type CreateDesignInput = {
  currentUserId: UserId;
  name: DesignName;
  baseImage: UploadedBaseImage;
  copiedFromDesignId?: DesignId;
};

export type DesignCreateOutcome =
  | { type: 'design_created'; design: DesignView }
  | DesignForbiddenOutcome
  /** An upload key was not issued to this caller, was reused, or expired. */
  | { type: 'design_upload_unowned' }
  | { type: 'design_image_invalid' }
  | { type: 'design_not_found' };

const newIds = (
  deps: DesignUseCaseDeps
): DesignResult<{ designId: DesignId; imageId: ImageId }> => {
  const designRaw = deps.idGenerator.createId();
  if (designRaw.isError()) return Result.Error(designRaw.getError());
  const imageRaw = deps.idGenerator.createId();
  if (imageRaw.isError()) return Result.Error(imageRaw.getError());
  const designId = toDesignId(designRaw.get());
  if (designId.isError()) return Result.Error(designId.getError());
  const imageId = toImageId(imageRaw.get());
  if (imageId.isError()) return Result.Error(imageId.getError());
  return Result.Ok({ designId: designId.get(), imageId: imageId.get() });
};

/**
 * Create a design around an uploaded base image. Both upload intents (the
 * original and the working copy) are consumed, so a caller can only attach
 * objects it was issued. A revised architect image passes
 * `copiedFromDesignId`, which must be another design the caller owns.
 */
export async function createDesign(
  deps: DesignUseCaseDeps,
  input: CreateDesignInput
): Promise<DesignResult<DesignCreateOutcome>> {
  const access = await checkDesignPermission(
    deps,
    input.currentUserId,
    'create'
  );
  if (access.isError()) return Result.Error(access.getError());
  if (access.get().type === 'forbidden') {
    return Result.Ok({ type: 'design_forbidden' });
  }

  const { baseImage } = input;
  if (
    !isValidImageDimensions(baseImage.original) ||
    !isValidImageDimensions(baseImage.working) ||
    !isConsistentWorkingCopy(baseImage) ||
    !objectKeyMatchesPurpose(baseImage.originalKey, 'base_image') ||
    !objectKeyMatchesPurpose(baseImage.workingKey, 'working_image')
  ) {
    return Result.Ok({ type: 'design_image_invalid' });
  }

  if (input.copiedFromDesignId) {
    const source = await deps.designRepository.findOwned({
      id: input.copiedFromDesignId,
      ownerId: input.currentUserId,
    });
    if (source.isError()) return Result.Error(source.getError());
    if (source.get().type === 'design_not_found') {
      return Result.Ok({ type: 'design_not_found' });
    }
  }

  const now = deps.clock.now();
  const original = await deps.uploadIntentStore.consume({
    objectKey: baseImage.originalKey,
    userId: input.currentUserId,
    purpose: 'base_image',
    now,
  });
  if (original.isError()) return Result.Error(original.getError());
  const originalIntent = original.get();
  if (originalIntent.type === 'upload_intent_unowned') {
    return Result.Ok({ type: 'design_upload_unowned' });
  }
  const working = await deps.uploadIntentStore.consume({
    objectKey: baseImage.workingKey,
    userId: input.currentUserId,
    purpose: 'working_image',
    now,
  });
  if (working.isError()) return Result.Error(working.getError());
  if (working.get().type === 'upload_intent_unowned') {
    return Result.Ok({ type: 'design_upload_unowned' });
  }

  const ids = newIds(deps);
  if (ids.isError()) return Result.Error(ids.getError());

  deps.logger.info({ event: 'design.create' });
  const created = await deps.writeDesignWithBaseImage({
    id: ids.get().designId,
    ownerId: input.currentUserId,
    name: input.name,
    copiedFromDesignId: input.copiedFromDesignId ?? null,
    baseImage: {
      id: ids.get().imageId,
      kind: 'base',
      originalKey: baseImage.originalKey,
      originalContentType: originalIntent.contentType,
      original: baseImage.original,
      workingKey: baseImage.workingKey,
      working: baseImage.working,
    },
  });
  if (created.isError()) return Result.Error(created.getError());
  const design = created.get().design;

  // A revised image: copy the mood board and placements; never fail creation.
  if (input.copiedFromDesignId) {
    const copied = await deps.designCopiedListener.designCopied({
      fromDesignId: input.copiedFromDesignId,
      toDesignId: design.id,
      toBaseImageId: design.baseImage.id,
    });
    if (copied.isError()) {
      deps.logger.warn({
        event: 'design.copy.failed',
        details: {
          designId: design.id,
          fromDesignId: input.copiedFromDesignId,
        },
      });
    }
  }

  // Dispatch after the copy attempt. The worker snapshots the saved categories.
  const announced = await deps.imageArrivedListener.imageArrived({
    designId: design.id,
    imageId: design.baseImage.id,
    kind: 'base',
    carryFromImageId: null,
  });
  if (announced.isError()) {
    deps.logger.warn({
      event: 'design.image_arrival.failed',
      details: { designId: design.id },
    });
  }

  const view = await toDesignView(deps, design);
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'design_created', design: view.get() });
}
