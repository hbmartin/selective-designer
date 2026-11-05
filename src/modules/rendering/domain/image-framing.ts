type ImageSize = { width: number; height: number };

/** Aspect ratios within 1% count as the same framing. */
export const hasFramingChanged = (result: ImageSize, source: ImageSize) =>
  Math.abs(result.width / result.height - source.width / source.height) /
    (source.width / source.height) >
  0.01;
