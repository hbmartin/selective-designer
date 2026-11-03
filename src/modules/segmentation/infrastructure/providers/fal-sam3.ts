import { Result } from '@bloodyowl/boxed';
import { createFalClient } from '@fal-ai/client';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { Segmenter } from '@/modules/segmentation/application/ports/ports';

const ENDPOINT = 'fal-ai/sam-3/image';
/** fal lists SAM 3 at $0.005 per request. */
const PRICE_USD_MICROS = 5_000;

const px = (fraction: number, size: number) => Math.round(fraction * size);

/** SAM 3 on fal: text, point and box prompts → mask PNG URLs. */
export const createFalSam3Segmenter = (config: {
  falKey: string;
}): Segmenter => {
  const fal = createFalClient({ credentials: config.falKey });
  return {
    async segment(input) {
      const { prompt, width, height } = input;
      try {
        const result = await fal.subscribe(ENDPOINT, {
          input: {
            image_url: input.imageUrl,
            output_format: 'png',
            include_scores: true,
            include_boxes: true,
            return_multiple_masks: input.maxMasks > 1,
            max_masks: input.maxMasks,
            ...(prompt.type === 'text' ? { prompt: prompt.text } : {}),
            ...(prompt.type === 'click'
              ? {
                  point_prompts: prompt.points.map((point) => ({
                    x: px(point.x, width),
                    y: px(point.y, height),
                    label: point.positive ? ('1' as const) : ('0' as const),
                  })),
                }
              : {}),
            ...(prompt.type === 'box'
              ? {
                  box_prompts: [
                    {
                      x_min: px(prompt.box.x, width),
                      y_min: px(prompt.box.y, height),
                      x_max: px(prompt.box.x + prompt.box.width, width),
                      y_max: px(prompt.box.y + prompt.box.height, height),
                    },
                  ],
                }
              : {}),
          },
        });
        const data = result.data;
        return Result.Ok({
          type: 'segmented',
          masks: data.masks.map((mask, index) => {
            const box = data.boxes?.[index];
            return {
              mask: { kind: 'url' as const, url: mask.url },
              box:
                box && box.length >= 4
                  ? ([box[0], box[1], box[2], box[3]] as [
                      number,
                      number,
                      number,
                      number,
                    ])
                  : ([0, 0, width, height] as [number, number, number, number]),
              score: data.scores?.[index] ?? null,
            };
          }),
          provider: 'fal',
          endpoint: ENDPOINT,
          providerRequestId: result.requestId,
          costUsdMicros: PRICE_USD_MICROS,
          costSource: 'price_table',
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
            type: 'segmentation_failed',
            reason: `provider_rejected_${status}`,
            provider: 'fal',
            endpoint: ENDPOINT,
          });
        }
        return Result.Error(
          new AppError({
            code: 'SEGMENTATION_UNAVAILABLE',
            category: status === 429 ? 'rate_limit' : 'system',
            status: status === 429 ? 429 : 502,
            message: 'Segmentation provider call failed',
            cause: error,
          })
        );
      }
    },
  };
};
