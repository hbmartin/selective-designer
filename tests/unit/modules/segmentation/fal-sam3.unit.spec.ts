import { ValidationError } from '@fal-ai/client';
import { okValue } from '@tests/support/result';
import { expect, it, vi } from 'vitest';

import { toObjectKey } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { createFalSam3Segmenter } from '@/modules/segmentation/backend';

const subscribe = vi.hoisted(() => vi.fn());
vi.mock('@fal-ai/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fal-ai/client')>()),
  createFalClient: () => ({ subscribe }),
}));

it.each([
  { fields: ['prompt'], terminal: true },
  { fields: ['point_prompts'], terminal: false },
  { fields: ['box_prompts'], terminal: false },
  { fields: ['prompt', 'image_url'], terminal: false },
  { fields: [], terminal: false },
])(
  'only marks prompt-only validation terminal ($fields)',
  async ({ fields, terminal }) => {
    subscribe.mockRejectedValueOnce(
      new ValidationError({
        message: 'Validation failed',
        status: 422,
        body: {
          detail: fields.map((field) => ({
            loc: ['body', field],
            msg: 'Invalid input',
            type: 'value_error',
          })),
        },
      })
    );

    const result = okValue(
      await createFalSam3Segmenter({ falKey: 'test' }).segment({
        imageUrl: 'https://example.test/image.png',
        imageKey: unwrapParseResult(toObjectKey('images/source.png')),
        width: 100,
        height: 100,
        prompt: { type: 'text', text: 'chair' },
        maxMasks: 1,
      })
    );

    expect(result).toEqual({
      type: 'segmentation_failed',
      provider: 'fal',
      endpoint: 'fal-ai/sam-3/image',
      reason: 'provider_rejected_422',
      ...(terminal ? { terminal: true } : {}),
    });
  }
);
