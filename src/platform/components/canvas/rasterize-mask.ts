/** Points are fractions of the image (0–1), flattened as [x0, y0, x1, y1, …]. */
export type MaskShape =
  | { kind: 'polygon'; points: number[] }
  | { kind: 'stroke'; points: number[]; widthFraction: number };

export type FractionalBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Bounding box of the shapes (strokes padded by half their width). */
export const shapesBox = (
  shapes: readonly MaskShape[],
  size: { width: number; height: number }
): FractionalBox | null => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    const padX = shape.kind === 'stroke' ? shape.widthFraction / 2 : 0;
    const padY =
      shape.kind === 'stroke'
        ? (shape.widthFraction * size.width) / size.height / 2
        : 0;
    for (let index = 0; index + 1 < shape.points.length; index += 2) {
      const x = shape.points[index] ?? 0;
      const y = shape.points[index + 1] ?? 0;
      minX = Math.min(minX, x - padX);
      maxX = Math.max(maxX, x + padX);
      minY = Math.min(minY, y - padY);
      maxY = Math.max(maxY, y + padY);
    }
  }
  if (!Number.isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0)
    return null;
  const x = clamp01(minX);
  const y = clamp01(minY);
  return { x, y, width: clamp01(maxX) - x, height: clamp01(maxY) - y };
};

/**
 * Draw shapes as a white-on-black PNG at the image's native size, the format
 * region masks use. Runs in the browser (no server image library).
 */
export const rasterizeMask = async (
  shapes: readonly MaskShape[],
  size: { width: number; height: number }
): Promise<{ blob: Blob; box: FractionalBox } | null> => {
  const box = shapesBox(shapes, size);
  if (!box) return null;
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = 'black';
  context.fillRect(0, 0, size.width, size.height);
  context.fillStyle = 'white';
  context.strokeStyle = 'white';
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const shape of shapes) {
    context.beginPath();
    for (let index = 0; index + 1 < shape.points.length; index += 2) {
      const x = (shape.points[index] ?? 0) * size.width;
      const y = (shape.points[index + 1] ?? 0) * size.height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    if (shape.kind === 'polygon') {
      context.closePath();
      context.fill();
    } else {
      context.lineWidth = shape.widthFraction * size.width;
      context.stroke();
    }
  }
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  );
  return blob ? { blob, box } : null;
};
