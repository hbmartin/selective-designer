import type { ImageDimensions } from '../domain/design';
import { workingImageSize } from '../domain/image-policy';

export const ACCEPTED_BASE_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export const isAcceptedBaseImageFile = (file: File) =>
  (ACCEPTED_BASE_IMAGE_TYPES as readonly string[]).includes(file.type);

export type PreparedImageFiles = {
  original: File;
  originalSize: ImageDimensions;
  working: File;
  workingSize: ImageDimensions;
};

/**
 * Decode an image in the browser and produce the working copy models receive
 * (≤ 2048 px on the long edge, same type). The server has no image library,
 * so this is where resizing happens.
 */
export async function prepareImageFiles(
  file: File
): Promise<PreparedImageFiles> {
  const bitmap = await createImageBitmap(file);
  try {
    const originalSize = { width: bitmap.width, height: bitmap.height };
    const workingSize = workingImageSize(originalSize);
    if (
      workingSize.width === originalSize.width &&
      workingSize.height === originalSize.height
    ) {
      return { original: file, originalSize, working: file, workingSize };
    }

    const canvas = document.createElement('canvas');
    canvas.width = workingSize.width;
    canvas.height = workingSize.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, workingSize.width, workingSize.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, file.type, 0.92)
    );
    if (!blob) throw new Error('Could not encode the working copy');
    const working = new File([blob], `working-${file.name}`, {
      type: file.type,
    });
    return { original: file, originalSize, working, workingSize };
  } finally {
    bitmap.close();
  }
}

/** First image file from a paste event, if any. */
export const imageFileFromClipboard = (
  event: Pick<ClipboardEvent, 'clipboardData'>
): File | undefined =>
  [...(event.clipboardData?.files ?? [])].find(isAcceptedBaseImageFile);
