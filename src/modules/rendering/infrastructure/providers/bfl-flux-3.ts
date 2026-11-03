import { Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { ImageModelAdapter } from '@/modules/rendering/application/ports/ports';

const BFL_URL = 'https://api.bfl.ai/v1/flux-3-image';
const TIMEOUT_MS = 30_000;

const submitSchema = z.object({
  id: z.string(),
  polling_url: z.string().url(),
});
const pollSchema = z.object({
  status: z.string(),
  result: z
    .object({ sample: z.string().url().optional() })
    .passthrough()
    .nullish(),
});

const PENDING = new Set(['Pending', 'Reasoning', 'Generating']);

const transient = (code: string, cause: unknown, status = 502) =>
  new AppError({
    code,
    category: status === 429 ? 'rate_limit' : 'system',
    status,
    message: 'FLUX 3 request failed',
    cause,
  });

/**
 * Black Forest Labs FLUX 3 Image (direct API). Boxes travel inside the prompt
 * (see prompt-builder); web grounding is turned off so client renders never
 * trigger web search. No webhooks: results are polled, then copied at once
 * (delivery links expire).
 */
export const createBflFlux3Model = (config: {
  apiKey: string;
  fetch?: typeof fetch;
}): ImageModelAdapter => {
  const doFetch = config.fetch ?? fetch;
  const call = async (url: string, init?: RequestInit) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await doFetch(url, {
        ...init,
        headers: {
          'x-key': config.apiKey,
          'content-type': 'application/json',
          ...init?.headers,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async submit(request) {
      const body = {
        prompt: request.prompt,
        images: [request.sourceImageUrl, ...request.referenceUrls],
        resolution: 'match_input',
        grounding: false,
        safety_tolerance: 2,
      };
      try {
        const response = await call(BFL_URL, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (
          response.status === 400 ||
          response.status === 402 ||
          response.status === 422
        ) {
          return Result.Ok({
            type: 'model_rejected',
            reason: `provider_rejected_${response.status}`,
          });
        }
        if (!response.ok)
          return Result.Error(
            transient(
              'FLUX_SUBMIT_FAILED',
              response.status,
              response.status === 429 ? 429 : 502
            )
          );
        const parsed = submitSchema.safeParse(await response.json());
        if (!parsed.success)
          return Result.Error(transient('FLUX_SUBMIT_INVALID', parsed.error));
        return Result.Ok({
          type: 'model_submitted',
          // The polling URL is what we need later; it embeds the task id.
          providerRequestId: parsed.data.polling_url,
          settings: {
            resolution: body.resolution,
            grounding: false,
            safety_tolerance: 2,
          },
        });
      } catch (error) {
        return Result.Error(transient('FLUX_SUBMIT_FAILED', error));
      }
    },
    async poll(pollingUrl) {
      try {
        const response = await call(pollingUrl);
        if (!response.ok && response.status !== 503) {
          return Result.Error(
            transient(
              'FLUX_POLL_FAILED',
              response.status,
              response.status === 429 ? 429 : 502
            )
          );
        }
        const parsed = pollSchema.safeParse(await response.json());
        if (!parsed.success)
          return Result.Error(transient('FLUX_POLL_INVALID', parsed.error));
        const { status, result } = parsed.data;
        if (PENDING.has(status)) return Result.Ok({ type: 'model_pending' });
        if (status === 'Ready' && result?.sample) {
          return Result.Ok({
            type: 'model_completed',
            outputUrl: result.sample,
            outputBytes: null,
            modelVersion: 'flux-3-image',
            costUsdMicros: null,
            costSource: 'unavailable',
          });
        }
        return Result.Ok({
          type: 'model_failed',
          reason: `flux_${status.toLowerCase().replaceAll(' ', '_')}`,
        });
      } catch (error) {
        return Result.Error(transient('FLUX_POLL_FAILED', error));
      }
    },
  };
};
