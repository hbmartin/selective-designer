import { Result } from '@bloodyowl/boxed';
import { createFalClient } from '@fal-ai/client';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { BackgroundRemover } from '@/modules/moodboard/application/ports/background-remover';

const ENDPOINT = 'fal-ai/birefnet/v2';

/**
 * BiRefNet v2 on fal: product-photo background removal. Runs synchronously
 * inside a workflow step via `subscribe` (seconds per image).
 */
export const createFalBackgroundRemover = (config: {
  falKey: string;
}): BackgroundRemover => {
  const fal = createFalClient({ credentials: config.falKey });
  return {
    async removeBackground(input) {
      try {
        const result = await fal.subscribe(ENDPOINT, {
          input: {
            image_url: input.sourceUrl,
            model: 'General Use (Heavy)',
            operating_resolution: '2048x2048',
            output_format: 'png',
            refine_foreground: true,
          },
        });
        const url = result.data.image?.url;
        if (!url) {
          return Result.Ok({
            type: 'background_removal_failed',
            reason: 'no_image_in_response',
            provider: 'fal',
            endpoint: ENDPOINT,
          });
        }
        return Result.Ok({
          type: 'background_removed',
          result: { kind: 'url', url },
          provider: 'fal',
          endpoint: ENDPOINT,
          providerRequestId: result.requestId,
          // fal does not report per-call cost for this endpoint.
          costUsdMicros: undefined,
          costSource: 'unavailable',
        });
      } catch (error) {
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? Number(error.status)
            : undefined;
        if (
          status !== undefined &&
          status >= 400 &&
          status < 500 &&
          status !== 429
        ) {
          return Result.Ok({
            type: 'background_removal_failed',
            reason: `provider_rejected_${status}`,
            provider: 'fal',
            endpoint: ENDPOINT,
          });
        }
        return Result.Error(
          new AppError({
            code: 'BACKGROUND_REMOVAL_UNAVAILABLE',
            category: status === 429 ? 'rate_limit' : 'system',
            status: status === 429 ? 429 : 502,
            message: 'Background removal provider call failed',
            cause: error,
          })
        );
      }
    },
  };
};
