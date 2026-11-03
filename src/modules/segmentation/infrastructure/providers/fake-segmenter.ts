import { Result } from '@bloodyowl/boxed';
import { encode } from 'fast-png';

import type { Segmenter } from '@/modules/segmentation/application/ports/ports';
import type { FractionalBox } from '@/modules/segmentation/domain/region';

/**
 * Deterministic local stand-in (PROVIDER_MODE=fake). Produces rectangular
 * masks: the prompted box, a box around clicks, and for text prompts a band
 * whose position derives from the text so different concepts differ.
 */
const MASK_EDGE = 256;

const maskPng = (box: FractionalBox) => {
  const data = new Uint8Array(MASK_EDGE * MASK_EDGE);
  const x0 = Math.floor(box.x * MASK_EDGE);
  const y0 = Math.floor(box.y * MASK_EDGE);
  const x1 = Math.ceil((box.x + box.width) * MASK_EDGE);
  const y1 = Math.ceil((box.y + box.height) * MASK_EDGE);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) data[y * MASK_EDGE + x] = 255;
  }
  return encode({
    width: MASK_EDGE,
    height: MASK_EDGE,
    data,
    channels: 1,
    depth: 8,
  });
};

const hash = (text: string) =>
  [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 7);

const boxFor = (
  prompt: Parameters<Segmenter['segment']>[0]['prompt']
): FractionalBox | null => {
  if (prompt.type === 'box') return prompt.box;
  if (prompt.type === 'click') {
    const point = prompt.points.find((p) => p.positive);
    if (!point) return null;
    const x = Math.max(0, point.x - 0.08);
    const y = Math.max(0, point.y - 0.08);
    return {
      x,
      y,
      width: Math.min(0.16, 1 - x),
      height: Math.min(0.16, 1 - y),
    };
  }
  const offset = (hash(prompt.text) % 6) / 10;
  return { x: 0.05, y: offset, width: 0.9, height: 0.12 };
};

export const createFakeSegmenter = (): Segmenter => ({
  async segment(input) {
    const box = boxFor(input.prompt);
    const toPixels = (b: FractionalBox): [number, number, number, number] => [
      b.x * input.width,
      b.y * input.height,
      (b.x + b.width) * input.width,
      (b.y + b.height) * input.height,
    ];
    return Result.Ok({
      type: 'segmented',
      masks: box
        ? [
            {
              mask: { kind: 'bytes', bytes: maskPng(box) },
              box: toPixels(box),
              score: 0.9,
            },
          ]
        : [],
      provider: 'fake',
      endpoint: 'fake/segmentation',
      providerRequestId: undefined,
      costUsdMicros: 0,
      costSource: 'price_table',
    });
  },
});
