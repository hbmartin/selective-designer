import type { ApplicationResult, ProviderCostSource } from '@/modules/kernel';
import type {
  DesignId,
  ImageId,
  ObjectKey,
  RegionId,
  UserId,
} from '@/modules/kernel/domain/ids';

import type {
  ClaimedDetectionRun,
  DetectionIdentity,
  DetectionLease,
  DetectionOmission,
  DetectionPhase,
  DetectionProgress,
  DetectionRun,
  DetectionSummary,
} from '../../domain/detection-run';
export type * from '../../domain/detection-run';

import type {
  FractionalBox,
  Region,
  RegionSource,
  SegmentationPrompt,
} from '../../domain/region';

export type NewRegion = {
  id: RegionId;
  designId: DesignId;
  imageId: ImageId;
  source: RegionSource;
  label: string;
  maskKey: ObjectKey;
  box: FractionalBox;
  score: number | null;
  isSuggestion: boolean;
  carriedFromRegionId: RegionId | null;
};

type DetectionClaim =
  | { type: 'detection_started' }
  | { type: 'detection_already_started' };
type WriteRegionsOutcome =
  | { type: 'regions_saved' }
  | { type: 'detection_superseded' };

export interface RegionRepository {
  listByImage(imageId: ImageId): Promise<
    ApplicationResult<{
      type: 'regions_listed';
      regions: Region[];
      detection: DetectionSummary;
    }>
  >;
  startDetection(input: {
    imageId: ImageId;
    runId: string;
    expiresAtMs: number;
    progress?: DetectionProgress;
    phase?: 'copying' | 'ready';
    imageWriteId?: string;
  }): Promise<ApplicationResult<DetectionClaim>>;
  resumeDetection(input: {
    previous: DetectionRun;
    runId: string;
    now: Date;
    expiresAtMs: number;
    progress?: DetectionProgress;
    dispatch: { previousPhase: DetectionPhase | null; initial: boolean };
  }): Promise<ApplicationResult<DetectionClaim>>;
  matchImageWrite(
    imageId: ImageId,
    imageWriteId: string
  ): Promise<
    ApplicationResult<{
      type: 'image_write_matched' | 'image_write_not_matched';
    }>
  >;
  findDetection(
    imageId: ImageId
  ): Promise<ApplicationResult<DetectionLease | { type: 'no_detection' }>>;
  detectionLabels(imageId: ImageId): Promise<ApplicationResult<string[]>>;
  claimDetection(
    run: ClaimedDetectionRun & { now: Date; expiresAt: Date }
  ): Promise<ApplicationResult<DetectionClaim>>;
  failDispatch(
    run: DetectionRun
  ): Promise<ApplicationResult<{ type: 'dispatch_failure_recorded' }>>;
  omitConcept(
    run: DetectionRun & DetectionOmission
  ): Promise<
    ApplicationResult<
      WriteRegionsOutcome | { type: 'detection_concept_already_completed' }
    >
  >;
  prepareDetection(
    input: DetectionRun & { concepts: string[] }
  ): Promise<
    ApplicationResult<
      | { type: 'detection_prepared'; progress: DetectionProgress }
      | { type: 'detection_superseded' }
    >
  >;
  finalizeDetection(run: DetectionRun & { now: Date }): Promise<
    ApplicationResult<{
      type: 'detection_finished' | 'detection_failed' | 'detection_superseded';
    }>
  >;
  finishDetection(
    run: DetectionRun & { now: Date }
  ): Promise<ApplicationResult<{ type: 'detection_finished' }>>;
  findById(
    regionId: RegionId
  ): Promise<
    ApplicationResult<
      { type: 'region_found'; region: Region } | { type: 'region_not_found' }
    >
  >;
  unreferencedMaskKeys(
    keys: readonly ObjectKey[]
  ): Promise<
    ApplicationResult<{ type: 'unreferenced_mask_keys'; keys: ObjectKey[] }>
  >;
  /** Errors use RegionWriteError: publication is rejected only when rollback is confirmed; otherwise unknown. */
  insertMany(
    regions: NewRegion[],
    run?: DetectionRun
  ): Promise<ApplicationResult<WriteRegionsOutcome>>;
  /** Replace one concept atomically. Failures carry the same RegionWriteError publication proof as insertMany. */
  replaceDetections(
    input: DetectionIdentity & {
      imageId: ImageId;
      concept: string;
      regions: NewRegion[];
      now?: Date;
    }
  ): Promise<
    ApplicationResult<
      WriteRegionsOutcome | { type: 'detection_concept_already_completed' }
    >
  >;
  update(input: {
    regionId: RegionId;
    label?: string;
    isSuggestion?: boolean;
  }): Promise<
    ApplicationResult<
      { type: 'region_found'; region: Region } | { type: 'region_not_found' }
    >
  >;
  remove(
    regionId: RegionId
  ): Promise<ApplicationResult<{ type: 'region_removed' }>>;
}

/** An image as segmentation needs it: working copy, owner and design. */
export type SegmentableImage = {
  imageId: ImageId;
  designId: DesignId;
  ownerId: UserId;
  workingKey: ObjectKey;
  width: number;
  height: number;
};

export interface ImageAccess {
  find(
    imageId: ImageId
  ): Promise<
    ApplicationResult<
      | { type: 'image_found'; image: SegmentableImage }
      | { type: 'image_missing' }
    >
  >;
}

/** Mood-board categories of a design (concepts for automatic detection). */
export interface ConceptSource {
  categoriesOf(designId: DesignId): Promise<ApplicationResult<string[]>>;
}

export type SegmentedMask = {
  /** Provider-hosted mask image, or PNG bytes from a local adapter. */
  mask: { kind: 'url'; url: string } | { kind: 'bytes'; bytes: Uint8Array };
  /** Pixel box (x_min, y_min, x_max, y_max) at the image's size. */
  box: [number, number, number, number];
  score: number | null;
};

export type SegmentationResult =
  | {
      type: 'segmented';
      masks: SegmentedMask[];
      provider: string;
      endpoint: string;
      providerRequestId: string | undefined;
      costUsdMicros: number | undefined;
      costSource: ProviderCostSource;
    }
  | {
      type: 'segmentation_failed';
      reason: string;
      terminal?: true;
      provider: string;
      endpoint: string;
    };

export interface Segmenter {
  segment(input: {
    imageUrl: string;
    imageKey: ObjectKey;
    width: number;
    height: number;
    prompt: SegmentationPrompt;
    maxMasks: number;
  }): Promise<ApplicationResult<SegmentationResult>>;
}

export interface AutoDetectionScheduler {
  schedule(input: {
    imageId: ImageId;
  }): Promise<
    ApplicationResult<
      | DetectionDispatch
      | { type: 'detection_intent_missing' }
      | { type: 'detection_already_finished' }
    >
  >;
}

export type DetectionDispatch =
  | { type: 'auto_detection_scheduled' }
  | { type: 'detection_queue_uncertain' }
  | { type: 'detection_queue_rejected' };

export interface DetectionRetry {
  retry(
    imageId: ImageId
  ): Promise<
    ApplicationResult<DetectionDispatch | { type: 'detection_not_retryable' }>
  >;
}

export interface DetectionQueue {
  enqueue(input: {
    imageId: ImageId;
    runId: string;
  }): Promise<
    ApplicationResult<
      { type: 'detection_enqueued' } | { type: 'detection_not_enqueued' }
    >
  >;
}
