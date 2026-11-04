import { Result } from '@bloodyowl/boxed';

import { cutoutRetryCutoff, isCutoutRetryable } from './cutout-retry-policy';
import type { MoodboardResult, MoodboardUseCaseDeps } from './types';
import { SIGNED_ITEM_URL_SECONDS } from './types';
import type { Item } from '../../domain/item';

/** An item with short-lived URLs for its photo and cut-out. */
export type ItemView = Item & {
  photoUrl: string;
  cutoutUrl: string | null;
  cutoutRetryable: boolean;
};

export const toItemView = async (
  deps: Pick<MoodboardUseCaseDeps, 'objectStorage' | 'clock'>,
  item: Item
): Promise<MoodboardResult<ItemView>> => {
  const sign = (objectKey: string) =>
    deps.objectStorage.createSignedReadUrl({
      objectKey,
      expiresInSeconds: SIGNED_ITEM_URL_SECONDS,
    });
  const photo = await sign(item.currentVersion.photo.key);
  if (photo.isError()) return Result.Error(photo.getError());
  let cutoutUrl: string | null = null;
  if (
    item.currentVersion.cutoutKey &&
    item.currentVersion.cutoutStatus === 'ready'
  ) {
    const cutout = await sign(item.currentVersion.cutoutKey);
    if (cutout.isError()) return Result.Error(cutout.getError());
    cutoutUrl = cutout.get().url;
  }
  return Result.Ok({
    ...item,
    photoUrl: photo.get().url,
    cutoutUrl,
    cutoutRetryable: isCutoutRetryable(
      item.currentVersion,
      cutoutRetryCutoff(deps.clock.now())
    ),
  });
};
