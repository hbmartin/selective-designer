import { Result } from '@bloodyowl/boxed';

import type { ImageId, UserId } from '@/modules/kernel/domain/ids';

import { checkDesignPermission } from './design-access';
import { signObjectKey } from './design-view';
import type {
  DesignForbiddenOutcome,
  DesignResult,
  DesignUseCaseDeps,
} from './types';

export type GetImageDownloadUrlInput = {
  currentUserId: UserId;
  imageId: ImageId;
};

export type ImageDownloadOutcome =
  | { type: 'image_download_url'; url: string }
  | { type: 'image_not_found' }
  | DesignForbiddenOutcome;

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Signed download link for an image the caller owns. Downloads return the
 * stored original exactly as uploaded or as the model returned it: no
 * resizing, labels or watermarks.
 */
export async function getImageDownloadUrl(
  deps: DesignUseCaseDeps,
  input: GetImageDownloadUrlInput
): Promise<DesignResult<ImageDownloadOutcome>> {
  const access = await checkDesignPermission(deps, input.currentUserId, 'read');
  if (access.isError()) return Result.Error(access.getError());
  if (access.get().type === 'forbidden') {
    return Result.Ok({ type: 'design_forbidden' });
  }

  const found = await deps.designRepository.findImage(input.imageId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (
    outcome.type === 'image_not_found' ||
    outcome.ownerId !== input.currentUserId
  ) {
    return Result.Ok({ type: 'image_not_found' });
  }

  const extension =
    EXTENSION_BY_TYPE[outcome.image.originalContentType] ?? 'png';
  const fileName = `${outcome.designName}-${outcome.image.kind}-${outcome.image.id}.${extension}`;
  const url = await signObjectKey(deps, outcome.image.originalKey, fileName);
  if (url.isError()) return Result.Error(url.getError());
  return Result.Ok({ type: 'image_download_url', url: url.get() });
}
