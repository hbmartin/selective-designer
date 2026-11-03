import { Result } from '@bloodyowl/boxed';
import { createFalClient } from '@fal-ai/client';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type {
  ImageModelAdapter,
  ModelRequest,
} from '@/modules/rendering/application/ports/ports';
import type { ModelSettings } from '@/modules/rendering/domain/render';

type FalInput = Record<string, unknown>;

const httpStatus = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : undefined;

const isPermanent = (status: number | undefined) =>
  status !== undefined && status >= 400 && status < 500 && status !== 429;

const transient = (code: string, error: unknown) => {
  const status = httpStatus(error);
  return new AppError({
    code,
    category: status === 429 ? 'rate_limit' : 'system',
    status: status === 429 ? 429 : 502,
    message: 'Image model provider call failed',
    cause: error,
  });
};

const NOT_RECORDED = new Set([
  'prompt',
  'image_url',
  'image_urls',
  'mask_url',
  'reference_image_urls',
]);

/** Scalar parameters only; inputs (URLs, prompt) are stored separately. */
export const recordedSettings = (input: FalInput): ModelSettings => {
  const settings: ModelSettings = {};
  for (const [key, value] of Object.entries(input)) {
    if (NOT_RECORDED.has(key)) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      settings[key] = value;
    } else if (Array.isArray(value)) {
      settings[`${key}_count`] = value.length;
    }
  }
  return settings;
};

const clampOpen = (value: number) => Math.min(0.999, Math.max(0, value));
const clampSize = (value: number) => Math.min(1, Math.max(0.001, value));

/** Krea 3 regional edit: boxes as `regions` on image 0, references after it. */
export const kreaInput = (request: ModelRequest): FalInput => ({
  image_urls: [request.sourceImageUrl, ...request.referenceUrls],
  prompt: request.prompt,
  ...(request.boxes.length > 0
    ? {
        regions: request.boxes.slice(0, 24).map((box, index) => ({
          image_idx: 0,
          x: clampOpen(box.x),
          y: clampOpen(box.y),
          width: clampSize(box.width),
          height: clampSize(box.height),
          label: `edit${index + 1}`,
        })),
        regional_edit: true,
        reasoning_level: 'high',
      }
    : { reasoning_level: 'medium' }),
  image_size: 'auto',
  output_format: 'png',
});

/** Ideogram 4.5: pixel mask (black = edit) with Precise Edit. */
export const ideogramInput = (request: ModelRequest): FalInput => ({
  prompt: request.prompt,
  image_url: request.sourceImageUrl,
  ...(request.referenceUrls.length > 0
    ? { reference_image_urls: request.referenceUrls }
    : {}),
  ...(request.maskUrl
    ? {
        mask_url: request.maskUrl,
        edit_precision: 'high',
        context_window: 'auto',
      }
    : { edit_precision: 'regular' }),
  quality: 'high',
});

/** GPT Image 2 via fal: mask white = edit; references follow the source. */
export const gptImageInput = (request: ModelRequest): FalInput => ({
  prompt: request.prompt,
  image_urls: [request.sourceImageUrl, ...request.referenceUrls],
  ...(request.maskUrl ? { mask_url: request.maskUrl } : {}),
  quality: 'high',
  image_size: 'auto',
  output_format: 'png',
  num_images: 1,
});

/**
 * fal queue adapter: submit returns a request id immediately; polling reads
 * the status and fetches the result once completed.
 */
export const createFalImageModel = (config: {
  falKey: string;
  endpoint: string;
  buildInput: (request: ModelRequest) => FalInput;
}): ImageModelAdapter => {
  const fal = createFalClient({ credentials: config.falKey });
  return {
    async submit(request) {
      const input = config.buildInput(request);
      try {
        const queued = await fal.queue.submit(config.endpoint, { input });
        return Result.Ok({
          type: 'model_submitted',
          providerRequestId: queued.request_id,
          settings: recordedSettings(input),
        });
      } catch (error) {
        if (isPermanent(httpStatus(error))) {
          return Result.Ok({
            type: 'model_rejected',
            reason: `provider_rejected_${httpStatus(error)}`,
          });
        }
        return Result.Error(transient('IMAGE_MODEL_SUBMIT_FAILED', error));
      }
    },
    async poll(requestId) {
      try {
        const status = await fal.queue.status(config.endpoint, {
          requestId,
          logs: false,
        });
        if (status.status !== 'COMPLETED')
          return Result.Ok({ type: 'model_pending' });
        const result = await fal.queue.result(config.endpoint, { requestId });
        const data = result.data as { images?: { url?: string }[] };
        const url = data.images?.[0]?.url ?? null;
        if (!url)
          return Result.Ok({
            type: 'model_failed',
            reason: 'no_image_in_response',
          });
        return Result.Ok({
          type: 'model_completed',
          outputUrl: url,
          outputBytes: null,
          modelVersion: config.endpoint,
          costUsdMicros: null,
          costSource: 'unavailable',
        });
      } catch (error) {
        if (isPermanent(httpStatus(error))) {
          return Result.Ok({
            type: 'model_failed',
            reason: `provider_error_${httpStatus(error)}`,
          });
        }
        return Result.Error(transient('IMAGE_MODEL_POLL_FAILED', error));
      }
    },
  };
};
