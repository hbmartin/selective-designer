/** Browser-side image helpers: the server has no image library. */

export const ACCEPTED_PHOTO_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export const isAcceptedPhoto = (file: File) =>
  (ACCEPTED_PHOTO_TYPES as readonly string[]).includes(file.type);

export const photoFromClipboard = (
  event: Pick<ClipboardEvent, 'clipboardData'>
) => [...(event.clipboardData?.files ?? [])].find(isAcceptedPhoto);

export const fileNameWithoutExtension = (name: string) =>
  name.replace(/\.[^.]+$/u, '').slice(0, 120);

export const readImageSize = async (file: Blob) => {
  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
};

/** Load a (signed, CORS-enabled) URL into an image usable on a canvas. */
export const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });

export const canvasToPngFile = async (
  canvas: HTMLCanvasElement,
  name: string
) => {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  );
  if (!blob) throw new Error('Could not encode PNG');
  return new File([blob], name, { type: 'image/png' });
};

export type CropBox = { x: number; y: number; width: number; height: number };

/** Crop a region (in natural pixels) of a loaded image into a PNG file. */
export const cropToPng = async (
  image: HTMLImageElement,
  box: CropBox,
  name: string
) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(box.width));
  canvas.height = Math.max(1, Math.round(box.height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  context.drawImage(
    image,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return canvasToPngFile(canvas, name);
};
