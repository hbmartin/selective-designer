/**
 * The image models a render fans out to. Each entry describes how the model
 * accepts a target area and reference images; adapters translate an edit set
 * into the model's request accordingly.
 */
export const modelIds = [
  'krea-3',
  'flux-3-image',
  'ideogram-4-5',
  'gpt-image-2',
] as const;
export type ModelId = (typeof modelIds)[number];

export const isModelId = (value: string): value is ModelId =>
  (modelIds as readonly string[]).includes(value);

/**
 * - `fractional_boxes`: target boxes as fractions (Krea `regions`).
 * - `prompt_grid_boxes`: boxes written into the prompt on a 0–1000 grid (FLUX 3).
 * - `mask`: a pixel mask image (Ideogram, GPT Image 2).
 */
export type Targeting = 'fractional_boxes' | 'prompt_grid_boxes' | 'mask';
/** Which mask colour marks the editable area for mask-targeted models. */
export type MaskPolarity = 'white_edits' | 'black_edits';

export type ModelSpec = {
  id: ModelId;
  displayName: string;
  provider: 'fal' | 'bfl';
  endpoint: string;
  targeting: Targeting;
  maskPolarity: MaskPolarity | null;
  maxReferences: number;
  /** Lower limit when a mask is sent alongside references. */
  maxReferencesWithMask: number;
  /** Smallest reliable size of a new element, in source pixels (vendor docs). */
  minTargetPx: { width: number; height: number };
  /** Estimated cost per render at ~2K, for the cost log when not reported. */
  estimatedCostUsdMicros: number | null;
};

export const MODEL_CATALOG: Record<ModelId, ModelSpec> = {
  'krea-3': {
    id: 'krea-3',
    displayName: 'Krea 3',
    provider: 'fal',
    endpoint: 'krea/v3/edit',
    targeting: 'fractional_boxes',
    maskPolarity: null,
    // fal accepts eight input images total, including the render source.
    maxReferences: 7,
    maxReferencesWithMask: 7,
    minTargetPx: { width: 48, height: 48 },
    estimatedCostUsdMicros: 170_000,
  },
  'flux-3-image': {
    id: 'flux-3-image',
    displayName: 'FLUX 3 Image',
    provider: 'bfl',
    endpoint: 'v1/flux-3-image',
    targeting: 'prompt_grid_boxes',
    maskPolarity: null,
    maxReferences: 9,
    maxReferencesWithMask: 9,
    minTargetPx: { width: 40, height: 25 },
    estimatedCostUsdMicros: 100_000,
  },
  'ideogram-4-5': {
    id: 'ideogram-4-5',
    displayName: 'Ideogram 4.5',
    provider: 'fal',
    endpoint: 'ideogram/v4.5/edit',
    targeting: 'mask',
    maskPolarity: 'black_edits',
    maxReferences: 4,
    maxReferencesWithMask: 3,
    minTargetPx: { width: 48, height: 48 },
    estimatedCostUsdMicros: 220_000,
  },
  'gpt-image-2': {
    id: 'gpt-image-2',
    displayName: 'GPT Image 2',
    provider: 'fal',
    endpoint: 'openai/gpt-image-2/edit',
    targeting: 'mask',
    maskPolarity: 'white_edits',
    maxReferences: 15,
    maxReferencesWithMask: 15,
    minTargetPx: { width: 48, height: 48 },
    estimatedCostUsdMicros: 234_000,
  },
};

/** Enabled models in configured order, ignoring unknown ids. */
export const enabledModels = (configuredIds: readonly string[]): ModelSpec[] =>
  configuredIds.filter(isModelId).map((id) => MODEL_CATALOG[id]);
