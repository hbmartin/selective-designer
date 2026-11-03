import { Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { ImageModelAdapter } from '@/modules/rendering/application/ports/ports';
import type { ModelId } from '@/modules/rendering/domain/model-catalog';

const PREFIX = 'fake:';

/**
 * Deterministic local stand-in (PROVIDER_MODE=fake): "renders" by returning
 * the render source unchanged. Like a real provider it fetches the signed
 * input URL, so it exercises storage signing and CORS-free server fetches.
 * Completes on the first poll; costs nothing.
 */
export const createFakeImageModel = (deps: {
  modelId: ModelId;
  fetch?: typeof fetch;
}): ImageModelAdapter => {
  const doFetch = deps.fetch ?? fetch;
  return {
    async submit(request) {
      return Result.Ok({
        type: 'model_submitted',
        providerRequestId: `${PREFIX}${deps.modelId}:${encodeURIComponent(request.sourceImageUrl)}`,
        settings: {
          fake: true,
          references: request.referenceUrls.length,
          boxes: request.boxes.length,
          masked: request.maskUrl !== null,
        },
      });
    },
    async poll(requestId) {
      const encoded = requestId.startsWith(PREFIX)
        ? requestId.slice(PREFIX.length + deps.modelId.length + 1)
        : '';
      if (!encoded)
        return Result.Ok({
          type: 'model_failed',
          reason: 'fake_unknown_request',
        });
      try {
        const response = await doFetch(decodeURIComponent(encoded));
        if (!response.ok) {
          return Result.Ok({
            type: 'model_failed',
            reason: `fake_source_${response.status}`,
          });
        }
        return Result.Ok({
          type: 'model_completed',
          outputUrl: null,
          outputBytes: {
            bytes: new Uint8Array(await response.arrayBuffer()),
            contentType: response.headers.get('content-type') ?? 'image/png',
          },
          modelVersion: `fake-${deps.modelId}`,
          costUsdMicros: 0,
          costSource: 'price_table',
        });
      } catch (error) {
        return Result.Error(
          new AppError({
            code: 'FAKE_MODEL_FETCH_FAILED',
            category: 'system',
            status: 502,
            message: 'Fake model could not read its source',
            cause: error,
          })
        );
      }
    },
  };
};
