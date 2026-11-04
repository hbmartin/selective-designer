import { imageSize } from 'image-size';

export type ImageDimensionsOutcome =
  | { type: 'dimensions'; width: number; height: number; format: string }
  | { type: 'unreadable' };

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

/** Reads only the header; no decoding (no server image library). */
export const readImageDimensions = (
  bytes: Uint8Array
): ImageDimensionsOutcome => {
  try {
    const size = imageSize(bytes);
    if (!size.width || !size.height || !size.type)
      return { type: 'unreadable' };
    // EXIF-rotated JPEGs report sensor dimensions; swap for 90° orientations.
    const rotated = size.orientation !== undefined && size.orientation >= 5;
    return {
      type: 'dimensions',
      width: rotated ? size.height : size.width,
      height: rotated ? size.width : size.height,
      format: size.type,
    };
  } catch {
    return { type: 'unreadable' };
  }
};

export const contentTypeForFormat = (format: string) =>
  Object.hasOwn(CONTENT_TYPES, format) ? CONTENT_TYPES[format] : undefined;
