import pixelmatch from 'pixelmatch';

/** Long edge of the comparison raster; small enough to be fast. */
const CHECK_LONG_EDGE = 512;
/** Blur both images first so resampling and grain do not count as change. */
const BLUR_PX = 1.5;
/** Widen the edit area so shadows and blending near edits are not flagged. */
const MASK_WIDEN_PX = 10;
/** Above this share of changed pixels outside the edits, warn. */
export const CHANGE_WARNING_PERCENT = 2;

export type ChangeCheck =
  | { status: 'ready'; percent: number; heatmapUrl: string; warning: boolean }
  | {
      status: 'unavailable';
      reason: 'framing_changed' | 'no_edit_mask' | 'image_unreadable';
    };

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`could not load ${url}`));
    image.src = url;
  });

const raster = (
  image: HTMLImageElement,
  size: { width: number; height: number },
  filter: string
) => {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d context');
  context.filter = filter;
  context.drawImage(image, 0, 0, size.width, size.height);
  return context.getImageData(0, 0, size.width, size.height);
};

/**
 * Advisory change check, run in the browser: compares a result with its
 * render source outside the (widened) edit mask and returns the share of
 * changed pixels plus a heatmap. Never modifies the result.
 */
export const runChangeCheck = async (input: {
  sourceUrl: string;
  resultUrl: string;
  maskUrl: string | null;
  framingChanged: boolean;
}): Promise<ChangeCheck> => {
  if (input.framingChanged)
    return { status: 'unavailable', reason: 'framing_changed' };
  if (!input.maskUrl) return { status: 'unavailable', reason: 'no_edit_mask' };
  try {
    const [source, result, mask] = await Promise.all([
      loadImage(input.sourceUrl),
      loadImage(input.resultUrl),
      loadImage(input.maskUrl),
    ]);
    const scale =
      CHECK_LONG_EDGE / Math.max(source.naturalWidth, source.naturalHeight);
    const size = {
      width: Math.max(1, Math.round(source.naturalWidth * scale)),
      height: Math.max(1, Math.round(source.naturalHeight * scale)),
    };
    const blur = `blur(${BLUR_PX}px)`;
    const a = raster(source, size, blur);
    const b = raster(result, size, blur);
    // A blurred mask spreads the edit area outward; any non-black pixel is "edit".
    const edit = raster(mask, size, `blur(${MASK_WIDEN_PX}px)`);
    let compared = 0;
    for (let index = 0; index < size.width * size.height; index += 1) {
      const offset = index * 4;
      if ((edit.data[offset] ?? 0) > 8) {
        // Inside the edits: make both identical so they never count.
        b.data[offset] = a.data[offset] ?? 0;
        b.data[offset + 1] = a.data[offset + 1] ?? 0;
        b.data[offset + 2] = a.data[offset + 2] ?? 0;
        b.data[offset + 3] = a.data[offset + 3] ?? 255;
      } else {
        compared += 1;
      }
    }
    const diff = new ImageData(size.width, size.height);
    const changed = pixelmatch(
      a.data,
      b.data,
      diff.data,
      size.width,
      size.height,
      {
        threshold: 0.12,
        alpha: 0.25,
      }
    );
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')?.putImageData(diff, 0, 0);
    const percent = compared > 0 ? (changed / compared) * 100 : 0;
    return {
      status: 'ready',
      percent,
      heatmapUrl: canvas.toDataURL('image/png'),
      warning: percent > CHANGE_WARNING_PERCENT,
    };
  } catch {
    return { status: 'unavailable', reason: 'image_unreadable' };
  }
};
