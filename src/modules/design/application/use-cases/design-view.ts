import { Result } from '@bloodyowl/boxed';

import type { ObjectKey } from '@/modules/kernel/domain/ids';

import type { DesignResult, DesignUseCaseDeps } from './types';
import { SIGNED_IMAGE_URL_SECONDS } from './types';
import type { Design, DesignImage } from '../../domain/design';

/** An image plus short-lived URLs the browser can load. */
export type DesignImageView = DesignImage & {
  workingUrl: string;
};

export type DesignView = Omit<Design, 'baseImage'> & {
  baseImage: DesignImageView;
};

export const signObjectKey = async (
  deps: Pick<DesignUseCaseDeps, 'objectStorage'>,
  objectKey: ObjectKey,
  attachmentFileName?: string
): Promise<DesignResult<string>> => {
  const signed = await deps.objectStorage.createSignedReadUrl({
    objectKey,
    expiresInSeconds: SIGNED_IMAGE_URL_SECONDS,
    ...(attachmentFileName ? { attachmentFileName } : {}),
  });
  if (signed.isError()) return Result.Error(signed.getError());
  return Result.Ok(signed.get().url);
};

export const toDesignImageView = async (
  deps: Pick<DesignUseCaseDeps, 'objectStorage'>,
  image: DesignImage
): Promise<DesignResult<DesignImageView>> => {
  const workingUrl = await signObjectKey(deps, image.workingKey);
  if (workingUrl.isError()) return Result.Error(workingUrl.getError());
  return Result.Ok({ ...image, workingUrl: workingUrl.get() });
};

export const toDesignView = async (
  deps: Pick<DesignUseCaseDeps, 'objectStorage'>,
  design: Design
): Promise<DesignResult<DesignView>> => {
  const baseImage = await toDesignImageView(deps, design.baseImage);
  if (baseImage.isError()) return Result.Error(baseImage.getError());
  return Result.Ok({ ...design, baseImage: baseImage.get() });
};
