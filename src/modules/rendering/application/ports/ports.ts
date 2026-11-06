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
} from '../../domain/render';
import type { RenderOutputCheckpoint } from '../../domain/render-output';

// ---- Persistence -------------------------------------------------------

export type NewRenderResult = {
  id: RenderResultId;
  modelId: ModelId;
  status: 'pending' | 'skipped';
  skipReason: string | null;
};

export type RenderAttemptIdentity = {
  resultId: RenderResultId;
  attempt: number;
  providerRequestId: string;
};
export type RenderCompletion = Pick<
  RenderResult,
  | 'modelVersion'
  | 'costUsdMicros'
  | 'costSource'
  | 'completedAt'
  | 'framingChanged'
>;

export type RenderExecution = {
  resultId: RenderResultId;
  attempt: number;
  workflowRunId: string;
};
export type RenderPublicationContext = {
  result: RenderResult;
  designId: DesignId;
  renderSourceImageId: ImageId;
  workflowRunId: string | null;
  checkpoint: RenderOutputCheckpoint | null;
  accountingIdentity: {
    invocationId: string;
    providerRequestId?: string;
  } | null;
  sourceSize: { width: number; height: number };
};

export interface RenderRepository {
  claimExecution(
    input: RenderExecution
  ): Promise<
    ApplicationResult<
      | { type: 'result_execution_claimed' }
      | { type: 'result_attempt_superseded' }
    >
  >;
  saveSubmission(
    input: RenderExecution & {
      providerRequestId: string;
      settings: ModelSettings;
      prompt: string;
      submittedAt: Date;
      accountingIdentity?: { invocationId: string; providerRequestId?: string };
    }
  ): Promise<
    ApplicationResult<
      { type: 'result_submitted' } | { type: 'result_attempt_superseded' }
    >
  >;
  saveOutput(
    input: RenderAttemptIdentity & { checkpoint: RenderOutputCheckpoint }
  ): Promise<
    ApplicationResult<
      | { type: 'result_output_saved'; checkpoint: RenderOutputCheckpoint }
      | { type: 'result_already_completed' }
      | { type: 'result_attempt_superseded' }
    >
  >;
  retryAttempt(input: {
    resultId: RenderResultId;
    expectedAttempt: number;
    startedAt: Date;
    expiredBeforeMs: number;
  }): Promise<
    ApplicationResult<
      | {
          type: 'result_retry_claimed';
          attempt: number;
          replacedObjectKey: ObjectKey | null;
        }
      | { type: 'result_attempt_superseded' }
    >
  >;
  failResultAttempt(
    input: RenderExecution & {
      providerRequestId?: string;
      reason: string;
      now: Date;
    }
  ): Promise<
    ApplicationResult<
      { type: 'result_marked_failed' } | { type: 'result_attempt_superseded' }
    >
  >;
  /** Focused result and parent metadata; lock is held through publication. */
  publicationContext(
    resultId: RenderResultId,
    lock?: 'update'
  ): Promise<
    ApplicationResult<
      | { type: 'publication_context'; context: RenderPublicationContext }
      | { type: 'result_not_found' }
    >
  >;
  completeResultAttempt(
    input: RenderAttemptIdentity & {
      imageId: ImageId;
      completion: RenderCompletion;
    }
  ): Promise<
    ApplicationResult<
      { type: 'result_completed' } | { type: 'result_attempt_superseded' }
    >
  >;
  referencedOutputKeys(
    keys: ObjectKey[]
  ): Promise<
    ApplicationResult<{ type: 'referenced_output_keys'; keys: ObjectKey[] }>
  >;
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
    attemptStartedAt: Date;
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
 * Atomically publishes the image, detection intent, render completion and link.
 * Completion is fenced by attempt/request; replay reuses the committed image.
 * Detection is dispatched after commit, including on reconciled replay.
 */
export interface ResultImages {
  findRegistered(
    input: RenderAttemptIdentity
  ): Promise<
    ApplicationResult<
      | RegisteredResultImage
      | { type: 'result_image_not_registered' }
      | { type: 'result_attempt_superseded' }
    >
  >;
  register(
    input: RenderAttemptIdentity & {
      designId: DesignId;
      renderSourceImageId: ImageId;
      objectKey: ObjectKey;
      contentType: string | undefined;
      completion: Omit<RenderCompletion, 'framingChanged' | 'completedAt'> & {
        completedAt: string;
      };
      sourceSize: { width: number; height: number };
    }
  ): Promise<
    ApplicationResult<
      | RegisteredResultImage
      | { type: 'result_image_unreadable' }
      | { type: 'result_attempt_superseded' }
    >
  >;
}

export type RegisteredResultImage = {
  type: 'result_image_registered';
  imageId: ImageId;
  width: number;
  height: number;
};

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
      accountingRequestId?: string;
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
  scheduleRender(input: {
    renderId: RenderId;
    attempts: { resultId: RenderResultId; attempt: number }[];
  }): Promise<ApplicationResult<{ type: 'render_scheduled' }>>;
  scheduleResult(input: {
    resultId: RenderResultId;
    attempt: number;
  }): Promise<ApplicationResult<{ type: 'render_scheduled' }>>;
}

/** Global references for render-owned output keys; publication loss is checked separately. */
export interface ResultOutputReferences {
  check(
    objectKey: ObjectKey
  ): Promise<
    ApplicationResult<
      { type: 'output_referenced' } | { type: 'output_unreferenced' }
    >
  >;
}
