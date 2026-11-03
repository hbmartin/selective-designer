import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { decode, encode } from 'fast-png';

import type { ObjectStoragePort } from '@/modules/kernel';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { IMMUTABLE_OBJECT_CACHE_CONTROL } from '@/modules/kernel/domain/upload-policy';
import type { MaskCompositor } from '@/modules/rendering/application/ports/ports';

/** Grow the target area slightly so seams and contact shadows are included. */
const DILATE_PX = 6;

const maskError = (code: string, cause: unknown) =>
  new AppError({
    code,
    category: 'system',
    status: 500,
    message: 'Mask processing failed',
    cause,
  });

/** On/off per pixel from a decoded PNG: luminance and alpha above half. */
export const toBinaryMask = (png: ReturnType<typeof decode>) => {
  const { width, height, channels, data } = png;
  const max = png.depth === 16 ? 65_535 : 255;
  const out = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * channels;
    const value =
      channels >= 3
        ? Math.max(
            data[offset] ?? 0,
            data[offset + 1] ?? 0,
            data[offset + 2] ?? 0
          )
        : (data[offset] ?? 0);
    const alpha =
      channels === 4
        ? (data[offset + 3] ?? max)
        : channels === 2
          ? (data[offset + 1] ?? max)
          : max;
    out[index] = value > max / 2 && alpha > max / 2 ? 1 : 0;
  }
  return { width, height, bits: out };
};

/** Nearest-neighbour union of `source` into `target` (resampled to fit). */
const unionResampled = (
  target: Uint8Array,
  size: { width: number; height: number },
  source: { width: number; height: number; bits: Uint8Array }
) => {
  for (let y = 0; y < size.height; y += 1) {
    const sy = Math.min(
      source.height - 1,
      Math.floor((y * source.height) / size.height)
    );
    for (let x = 0; x < size.width; x += 1) {
      const sx = Math.min(
        source.width - 1,
        Math.floor((x * source.width) / size.width)
      );
      if (source.bits[sy * source.width + sx]) target[y * size.width + x] = 1;
    }
  }
};

/** Fill a (possibly rotated) fractional box. */
export const fillRotatedBox = (
  target: Uint8Array,
  size: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
  rotationDeg: number
) => {
  const cx = (box.x + box.width / 2) * size.width;
  const cy = (box.y + box.height / 2) * size.height;
  const halfW = (box.width * size.width) / 2;
  const halfH = (box.height * size.height) / 2;
  const angle = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const reach = Math.ceil(Math.hypot(halfW, halfH));
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(size.width - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(size.height - 1, Math.ceil(cy + reach));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      // Rotate the point back into the box's frame.
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      if (Math.abs(u) <= halfW && Math.abs(v) <= halfH)
        target[y * size.width + x] = 1;
    }
  }
};

/** Separable square dilation by `radius` pixels. */
export const dilate = (
  bits: Uint8Array,
  width: number,
  height: number,
  radius: number
) => {
  const horizontal = new Uint8Array(bits.length);
  for (let y = 0; y < height; y += 1) {
    let last = -Infinity;
    for (let x = 0; x < width; x += 1) {
      if (bits[y * width + x]) last = x;
      if (x - last <= radius) horizontal[y * width + x] = 1;
    }
    last = Infinity;
    for (let x = width - 1; x >= 0; x -= 1) {
      if (bits[y * width + x]) last = x;
      if (last - x <= radius) horizontal[y * width + x] = 1;
    }
  }
  const out = new Uint8Array(bits.length);
  for (let x = 0; x < width; x += 1) {
    let last = -Infinity;
    for (let y = 0; y < height; y += 1) {
      if (horizontal[y * width + x]) last = y;
      if (y - last <= radius) out[y * width + x] = 1;
    }
    last = Infinity;
    for (let y = height - 1; y >= 0; y -= 1) {
      if (horizontal[y * width + x]) last = y;
      if (last - y <= radius) out[y * width + x] = 1;
    }
  }
  return out;
};

const toGrayPng = (
  bits: Uint8Array,
  width: number,
  height: number,
  onValue: number
) => {
  const data = new Uint8Array(bits.length);
  const offValue = 255 - onValue;
  for (let index = 0; index < bits.length; index += 1)
    data[index] = bits[index] ? onValue : offValue;
  return encode({ width, height, data, channels: 1, depth: 8 });
};

export const createPngMaskCompositor = (deps: {
  objectStorage: ObjectStoragePort;
}): MaskCompositor => {
  type BinaryMask = { width: number; height: number; bits: Uint8Array };
  const readMask = async (
    objectKey: string
  ): Promise<BoxedResult<BinaryMask, AppError>> => {
    const object = await deps.objectStorage.getObjectBytes(objectKey);
    if (object.isError()) return Result.Error(object.getError());
    const found = object.get();
    if (found.type === 'object_not_found') {
      return Result.Error(maskError('MASK_NOT_FOUND', objectKey));
    }
    try {
      return Result.Ok(toBinaryMask(decode(found.bytes)));
    } catch (error) {
      return Result.Error(maskError('MASK_DECODE_FAILED', error));
    }
  };

  return {
    async composeEditMask(input) {
      const { width, height } = input.size;
      const bits = new Uint8Array(width * height);
      for (const shape of input.shapes) {
        if (shape.kind === 'box') {
          fillRotatedBox(bits, input.size, shape.box, shape.rotationDeg);
        } else {
          // oxlint-disable-next-line no-await-in-loop -- a handful of masks.
          const mask = await readMask(shape.maskKey);
          if (mask.isError()) return Result.Error(mask.getError());
          unionResampled(bits, input.size, mask.get());
        }
      }
      const png = toGrayPng(
        dilate(bits, width, height, DILATE_PX),
        width,
        height,
        255
      );
      const stored = await deps.objectStorage.putObject({
        objectKey: input.objectKey,
        body: png,
        contentType: 'image/png',
        cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
      });
      if (stored.isError()) return Result.Error(stored.getError());
      return Result.Ok({
        type: 'edit_mask_composed',
        objectKey: input.objectKey,
      });
    },

    async maskForModel(input) {
      const existing = await deps.objectStorage.getObjectBytes(input.objectKey);
      if (existing.isError()) return Result.Error(existing.getError());
      if (existing.get().type === 'object_found') {
        return Result.Ok({
          type: 'model_mask_ready',
          objectKey: input.objectKey,
        });
      }
      const mask = await readMask(input.editMaskKey);
      if (mask.isError()) return Result.Error(mask.getError());
      const { width, height, bits } = mask.get();
      const png = toGrayPng(
        bits,
        width,
        height,
        input.polarity === 'white_edits' ? 255 : 0
      );
      const stored = await deps.objectStorage.putObject({
        objectKey: input.objectKey,
        body: png,
        contentType: 'image/png',
        cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
      });
      if (stored.isError()) return Result.Error(stored.getError());
      return Result.Ok({
        type: 'model_mask_ready',
        objectKey: input.objectKey,
      });
    },
  };
};
