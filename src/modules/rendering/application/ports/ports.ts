import type { ApplicationResult, ProviderCostSource } from '@/modules/kernel';
import type {
  BatchId,
  DesignId,
  ImageId,
  ObjectKey,
  RenderId,
  RenderResultId,
  UserId,
} from '@/modules/kernel/domain/ids';

import type { EditSet, FractionalBox } from '../../domain/edit-set';
import type { MaskPolarity, ModelId } from '../../domain/model-catalog';
import type { RenderRecipe } from '../../domain/recipe';
import type {
  Draft,
  ModelSettings,
  Render,
  RenderResult,
  RenderResultStatus,
} from '../../domain/render';

// ---- Persistence -------------------------------------------------------

export type NewRenderResult = {
  id: RenderResultId;
  modelId: ModelId;
  status: 'pending' | 'skipped';
  skipReason: string | null;
};

export interface RenderRepository {
  findDraft(
    renderSourceImageId: ImageId
  ): Promise<
    ApplicationResult<
      { type: 'draft_found'; draft: Draft } | { type: 'draft_missing' }
    >
  >;
  /** Optimistic concurrency: saves only when `expectedRevision` matches. */
  saveDraft(input: {
    designId: DesignId;
    renderSourceImageId: ImageId;
    editSet: EditSet;
    expectedRevision: number;
  }): Promise<
    ApplicationResult<
      | { type: 'draft_saved'; draft: Draft }
      | { type: 'draft_conflict'; draft: Draft }
    >
  >;
  createRender(input: {
    id: RenderId;
    designId: DesignId;
    renderSourceImageId: ImageId;
    batchId: BatchId | null;
    batchOptionItemId: string | null;
    recipe: RenderRecipe;
    results: NewRenderResult[];
  }): Promise<ApplicationResult<{ type: 'render_created'; render: Render }>>;
  findRender(
    renderId: RenderId
  ): Promise<
    ApplicationResult<
      { type: 'render_found'; render: Render } | { type: 'render_not_found' }
    >
  >;
  listRenders(
    designId: DesignId
  ): Promise<ApplicationResult<{ type: 'renders_listed'; renders: Render[] }>>;
  /** The render that produced `imageId` as one of its results, if any. */
  findRenderByOutputImage(
    imageId: ImageId
  ): Promise<
    ApplicationResult<
      { type: 'render_found'; render: Render } | { type: 'render_not_found' }
    >
  >;
  /** Per model: finished results and how often each was preferred. */
  scorecard(ownerId: UserId): Promise<
    ApplicationResult<{
      type: 'scorecard';
      rows: {
        modelId: string;
        succeeded: number;
        preferred: number;
        rendersWithPreference: number;
      }[];
    }>
  >;
  findResult(
    resultId: RenderResultId
  ): Promise<
    ApplicationResult<
      | { type: 'result_found'; result: RenderResult; render: Render }
      | { type: 'result_not_found' }
    >
  >;
  updateResult(input: {
    resultId: RenderResultId;
    changes: Partial<{
      status: RenderResultStatus;
      attempt: number;
      providerRequestId: string | null;
      modelVersion: string | null;
      settings: ModelSettings;
      prompt: string | null;
      outputImageId: ImageId | null;
      framingChanged: boolean;
      errorMessage: string | null;
      costUsdMicros: number | null;
      costSource: ProviderCostSource | null;
      submittedAt: Date | null;
      completedAt: Date | null;
    }>;
  }): Promise<ApplicationResult<{ type: 'result_updated' }>>;
  setPreferredResult(input: {
    renderId: RenderId;
    resultId: RenderResultId | null;
  }): Promise<ApplicationResult<{ type: 'preferred_result_set' }>>;
  setSchemeName(input: {
    designId: DesignId;
    resultId: RenderResultId;
    name: string | null;
  }): Promise<ApplicationResult<{ type: 'scheme_saved' }>>;
}

// ---- Inputs from other capabilities -----------------------------------

export type SourceImage = {
  imageId: ImageId;
  designId: DesignId;
  ownerId: UserId;
  workingKey: ObjectKey;
  width: number;
  height: number;
};

export type InputItem = {
  itemId: string;
  designId: DesignId;
  itemVersionId: string;
  name: string;
  kind: 'product' | 'extract' | 'swatch';
  /** Cut-out (products, extracts) or photo (swatches); null while pending. */
  referenceKey: ObjectKey | null;
};

export type InputRegion = {
  regionId: string;
  imageId: ImageId;
  /** Set when the region was carried over from the render source. */
  carriedFromRegionId: string | null;
  label: string;
  maskKey: ObjectKey;
  box: FractionalBox;
};

/** Read access to images, items and regions owned by other modules. */
export interface RenderInputs {
  sourceImage(
    imageId: ImageId
  ): Promise<
    ApplicationResult<
      { type: 'found'; image: SourceImage } | { type: 'missing' }
    >
  >;
  item(
    itemId: string
  ): Promise<
    ApplicationResult<{ type: 'found'; item: InputItem } | { type: 'missing' }>
  >;
  region(
    regionId: string
  ): Promise<
    ApplicationResult<
      { type: 'found'; region: InputRegion } | { type: 'missing' }
    >
  >;
}

/**
 * Stores a copied model output as a design image (reading its dimensions) and
 * starts eager detection with region carry-over from the render source.
 */
export interface ResultImages {
  register(input: {
    designId: DesignId;
    renderSourceImageId: ImageId;
    objectKey: ObjectKey;
    contentType: string;
  }): Promise<
    ApplicationResult<
      | {
          type: 'result_image_registered';
          imageId: ImageId;
          width: number;
          height: number;
        }
      | { type: 'result_image_unreadable' }
    >
  >;
}

// ---- Masks -----------------------------------------------------------

export type MaskShape =
  | { kind: 'region'; maskKey: string }
  | { kind: 'box'; box: FractionalBox; rotationDeg: number };

export interface MaskCompositor {
  /** Union of shapes at `size`, slightly dilated; white = edit. */
  composeEditMask(input: {
    size: { width: number; height: number };
    shapes: MaskShape[];
    objectKey: ObjectKey;
  }): Promise<
    ApplicationResult<{ type: 'edit_mask_composed'; objectKey: ObjectKey }>
  >;
  /** A copy of an edit mask in the polarity a model expects. */
  maskForModel(input: {
    editMaskKey: ObjectKey;
    polarity: MaskPolarity;
    objectKey: ObjectKey;
  }): Promise<
    ApplicationResult<{ type: 'model_mask_ready'; objectKey: ObjectKey }>
  >;
}

// ---- Models ----------------------------------------------------------

export type ModelRequest = {
  sourceImageUrl: string;
  sourceSize: { width: number; height: number };
  referenceUrls: string[];
  /** Target boxes (empty when only a whole-image prompt). */
  boxes: FractionalBox[];
  /** Mask URL in the model's own polarity, when the model takes a mask. */
  maskUrl: string | null;
  prompt: string;
};

export type ModelSubmission =
  | {
      type: 'model_submitted';
      providerRequestId: string;
      settings: ModelSettings;
    }
  | { type: 'model_rejected'; reason: string };

export type ModelPoll =
  | { type: 'model_pending' }
  | {
      type: 'model_completed';
      outputUrl: string | null;
      outputBytes: { bytes: Uint8Array; contentType: string } | null;
      modelVersion: string | null;
      costUsdMicros: number | null;
      costSource: ProviderCostSource;
    }
  | { type: 'model_failed'; reason: string };

export interface ImageModelAdapter {
  submit(request: ModelRequest): Promise<ApplicationResult<ModelSubmission>>;
  poll(providerRequestId: string): Promise<ApplicationResult<ModelPoll>>;
}

export interface ImageModels {
  adapterFor(modelId: ModelId): ImageModelAdapter;
}

// ---- Scheduling -------------------------------------------------------

export interface RenderScheduler {
  scheduleRender(
    renderId: RenderId
  ): Promise<ApplicationResult<{ type: 'render_scheduled' }>>;
  scheduleResult(
    resultId: RenderResultId
  ): Promise<ApplicationResult<{ type: 'render_scheduled' }>>;
}
