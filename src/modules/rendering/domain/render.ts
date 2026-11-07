import type { ProviderCostSource } from '@/modules/kernel';
import type {
  BatchId,
  DesignId,
  ImageId,
  RenderId,
  RenderResultId,
} from '@/modules/kernel/domain/ids';

import type { EditSet } from './edit-set';
import type { ModelId } from './model-catalog';
import type { RenderRecipe } from './recipe';

/** The unfinished edits on one render source, autosaved. */
/** Flat, serialisable model parameters recorded for each result. */
export type ModelSettings = Record<string, string | number | boolean | null>;

export type Draft = {
  designId: DesignId;
  renderSourceImageId: ImageId;
  editSet: EditSet;
  revision: number;
  updatedAt: Date;
};

export const renderResultStatuses = [
  'pending',
  'submitted',
  'succeeded',
  'failed',
  'skipped',
] as const;
export type RenderResultStatus = (typeof renderResultStatuses)[number];
export const isRenderResultStatus = (
  status: string
): status is RenderResultStatus =>
  (renderResultStatuses as readonly string[]).includes(status);

export const isTerminalStatus = (status: RenderResultStatus) =>
  status === 'succeeded' || status === 'failed' || status === 'skipped';

/** One model's output for a render. */
export type RenderResult = {
  id: RenderResultId;
  renderId: RenderId;
  modelId: ModelId;
  status: RenderResultStatus;
  skipReason: string | null;
  attempt: number;
  attemptStartedAt: Date;
  providerRequestId: string | null;
  modelVersion: string | null;
  settings: ModelSettings;
  prompt: string | null;
  outputImageId: ImageId | null;
  /** The output's aspect ratio differs from the render source's. */
  framingChanged: boolean;
  errorMessage: string | null;
  costUsdMicros: number | null;
  costSource: ProviderCostSource | null;
  schemeName: string | null;
  submittedAt: Date | null;
  completedAt: Date | null;
};

export type Render = {
  id: RenderId;
  designId: DesignId;
  renderSourceImageId: ImageId;
  batchId: BatchId | null;
  batchOptionItemId: string | null;
  recipe: RenderRecipe;
  preferredResultId: RenderResultId | null;
  results: RenderResult[];
  createdAt: Date;
};

export type SkipReason = {
  reason: string;
  references: number | null;
  limit: number | null;
};

/** Skip reasons are stored as `reason:references/limit`. */
export const parseSkipReason = (value: string): SkipReason => {
  const match = /^([^:]+):(\d+)\/(\d+)$/u.exec(value);
  if (!match) return { reason: value, references: null, limit: null };
  return {
    reason: match[1] ?? value,
    references: Number(match[2]),
    limit: Number(match[3]),
  };
};
