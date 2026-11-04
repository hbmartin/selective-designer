import type {
  DesignId,
  ImageId,
  ObjectKey,
  RegionId,
} from '@/modules/kernel/domain/ids';

export const regionSources = [
  'detection',
  'click',
  'box',
  'text',
  'brush',
  'lasso',
] as const;
export type RegionSource = (typeof regionSources)[number];

/** User-made regions carry over to results continued from their image. */
export const isUserMadeSource = (source: RegionSource) =>
  source !== 'detection';

/** Box in fractions of the image size (0–1), independent of resolution. */
export type FractionalBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Region = {
  id: RegionId;
  designId: DesignId;
  imageId: ImageId;
  source: RegionSource;
  label: string;
  /** Mask PNG at the image's working size; white/opaque marks the region. */
  maskKey: ObjectKey;
  box: FractionalBox;
  score: number | null;
  /** Copied from a parent image; the user should confirm or adjust it. */
  isSuggestion: boolean;
  carriedFromRegionId: RegionId | null;
  createdAt: Date;
};

export const REGION_LABEL_MAX_LENGTH = 80;

/** What automatic detection looks for in every base image and result. */
export const DEFAULT_DETECTION_CONCEPTS = [
  'wall',
  'window',
  'door',
  'floor',
  'roof',
  'plant',
  'light fixture',
  'furniture',
] as const;

/** Upper bound so a large mood board cannot fan out unbounded SAM calls. */
export const MAX_DETECTION_CONCEPTS = 16;

/**
 * The fixed architectural list plus the design's mood-board categories,
 * lower-cased and de-duplicated, capped at {@link MAX_DETECTION_CONCEPTS}.
 */
export const detectionConcepts = (
  categories: readonly string[],
  fixed: readonly string[] = DEFAULT_DETECTION_CONCEPTS
): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of [...fixed, ...categories]) {
    const concept = raw.trim().toLowerCase().slice(0, REGION_LABEL_MAX_LENGTH);
    if (!concept || seen.has(concept)) continue;
    seen.add(concept);
    result.push(concept);
    if (result.length >= MAX_DETECTION_CONCEPTS) break;
  }
  return result;
};

export const clampFraction = (value: number) => Math.min(1, Math.max(0, value));

/** Pixel box (x_min, y_min, x_max, y_max) → fractional box. */
export const toFractionalBox = (
  pixels: readonly [number, number, number, number],
  size: { width: number; height: number }
): FractionalBox => {
  const [xMin, yMin, xMax, yMax] = pixels;
  const x = clampFraction(xMin / size.width);
  const y = clampFraction(yMin / size.height);
  return {
    x,
    y,
    width: clampFraction(xMax / size.width) - x,
    height: clampFraction(yMax / size.height) - y,
  };
};

export const isValidFractionalBox = (box: FractionalBox) =>
  [box.x, box.y, box.width, box.height].every(
    (value) => Number.isFinite(value) && value >= 0 && value <= 1
  ) &&
  box.width > 0 &&
  box.height > 0 &&
  box.x + box.width <= 1.000_001 &&
  box.y + box.height <= 1.000_001;

/** A prompt for interactive segmentation, in fractions of the image. */
export type SegmentationPrompt =
  | { type: 'click'; points: { x: number; y: number; positive: boolean }[] }
  | { type: 'box'; box: FractionalBox }
  | { type: 'text'; text: string };

export const isDetectionConceptSettled = (
  progress:
    | {
        completedConcepts: readonly string[];
        omissions?: readonly { concept: string }[];
      }
    | null
    | undefined,
  concept: string
) =>
  progress?.completedConcepts.includes(concept) === true ||
  progress?.omissions?.some((omission) => omission.concept === concept) ===
    true;
