import { Result } from '@bloodyowl/boxed';

import type { ObjectStoragePort } from '@/modules/kernel';
import type { BackgroundRemover } from '@/modules/moodboard/application/ports/background-remover';

/**
 * Deterministic local stand-in (PROVIDER_MODE=fake): returns the photo itself
 * as the "cut-out". No network, no cost.
 */
export const createFakeBackgroundRemover = (deps: {
  objectStorage: ObjectStoragePort;
}): BackgroundRemover => ({
  async removeBackground(input) {
    const source = await deps.objectStorage.getObjectBytes(input.sourceKey);
    if (source.isError()) return Result.Error(source.getError());
    const object = source.get();
    if (object.type === 'object_not_found') {
      return Result.Ok({
        type: 'background_removal_failed',
        reason: 'source_missing',
        provider: 'fake',
        endpoint: 'fake/background-removal',
      });
    }
    return Result.Ok({
      type: 'background_removed',
      result: {
        kind: 'bytes',
        bytes: object.bytes,
        contentType: object.contentType ?? 'image/png',
      },
      provider: 'fake',
      endpoint: 'fake/background-removal',
      providerRequestId: undefined,
      costUsdMicros: 0,
      costSource: 'price_table',
    });
  },
});
