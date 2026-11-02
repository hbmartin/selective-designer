import type { ImageDimensions } from './design';

/** Long edge of the copy models receive (they accept ~4 MP at most). */
export const WORKING_IMAGE_LONG_EDGE = 2048;

/** Sanity bound for client-reported dimensions (≈ 20k px per side). */
export const MAX_IMAGE_EDGE = 20_000;

export const isValidImageDimensions = (dimensions: ImageDimensions) =>
  Number.isInteger(dimensions.width) &&
  Number.isInteger(dimensions.height) &&
  dimensions.width > 0 &&
  dimensions.height > 0 &&
  dimensions.width <= MAX_IMAGE_EDGE &&
  dimensions.height <= MAX_IMAGE_EDGE;

/** Size of the working copy for an image of the given original size. */
export const workingImageSize = (
  original: ImageDimensions,
  longEdge = WORKING_IMAGE_LONG_EDGE
): ImageDimensions => {
  const scale = Math.min(
    1,
    longEdge / Math.max(original.width, original.height)
  );
  return {
    width: Math.max(1, Math.round(original.width * scale)),
    height: Math.max(1, Math.round(original.height * scale)),
  };
};

/**
 * Whether a reported working copy plausibly derives from the original: no
 * larger than the policy size and the same aspect ratio (±1 px rounding).
 */
export const isConsistentWorkingCopy = (input: {
  original: ImageDimensions;
  working: ImageDimensions;
}) => {
  const expected = workingImageSize(input.original);
  return (
    Math.abs(input.working.width - expected.width) <= 1 &&
    Math.abs(input.working.height - expected.height) <= 1
  );
};

/** Two images share framing when their aspect ratios match within 1%. */
export const haveSameFraming = (a: ImageDimensions, b: ImageDimensions) =>
  Math.abs(a.width / a.height - b.width / b.height) / (b.width / b.height) <=
  0.01;
