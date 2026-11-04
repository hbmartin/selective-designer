import type { ItemVersion } from '../../domain/item';

const CUTOUT_RETRY_AFTER_MS = 30 * 60 * 1000;

export const cutoutRetryCutoff = (now: Date) =>
  now.getTime() - CUTOUT_RETRY_AFTER_MS;

export const isCutoutRetryable = (version: ItemVersion, cutoffMs: number) =>
  version.cutoutStatus === 'failed' ||
  (version.cutoutStatus === 'pending' &&
    (version.cutoutAttemptStartedAt ?? version.createdAt).getTime() <=
      cutoffMs);
