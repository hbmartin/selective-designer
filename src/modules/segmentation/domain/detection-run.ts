import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { ImageId } from '@/modules/kernel/domain/ids';

export type DetectionIdentity =
  | { runId?: string | null; workerId?: never }
  | { runId: string; workerId: string };
export type DetectionRun = DetectionIdentity & {
  imageId: ImageId;
  runId: string | null;
  now?: Date;
};
export type ClaimedDetectionRun = Extract<DetectionRun, { workerId: string }>;
export type DetectionOmission = {
  concept: string;
  reason: 'prompt_rejected' | 'invalid_mask';
};
export type DetectionPhase =
  | 'copying'
  | 'ready'
  | 'queued'
  | 'running'
  | 'omissions'
  | 'completed';
export type DetectionProgress = {
  concepts: string[] | null;
  completedConcepts: string[];
  carryFromImageId: string | null;
  carryOverCompleted: boolean;
  omissions?: DetectionOmission[];
};
type DetectionStatus = {
  phase: DetectionPhase | null;
  expiresAt: Date;
  failed: boolean;
};
export type DetectionSummary =
  | { type: 'no_detection' }
  | (DetectionStatus & {
      type: 'detection_recorded';
      omissions: DetectionOmission[];
    });
export type DetectionLease = DetectionStatus & {
  type: 'detection_lease';
  runId: string | null;
  workerId: string | null;
  progress: DetectionProgress | null;
};

export const detectionRunFor = (
  imageId: ImageId,
  { runId, workerId }: DetectionIdentity
): BoxedResult<DetectionRun | undefined, AppError> => {
  if (workerId !== undefined) {
    if (
      typeof runId !== 'string' ||
      !runId ||
      typeof workerId !== 'string' ||
      !workerId
    )
      return Result.Error(
        new AppError({
          code: 'DETECTION_IDENTITY_INVALID',
          category: 'system',
          status: 500,
          message: 'A claimed detection requires both a run ID and a worker ID',
        })
      );
    return Result.Ok({ imageId, runId, workerId });
  }
  return Result.Ok(runId === undefined ? undefined : { imageId, runId });
};

export const ownsDetectionLease = (
  lease: DetectionLease | { type: 'no_detection' },
  run: DetectionRun,
  now: Date
): lease is DetectionLease =>
  lease.type === 'detection_lease' &&
  lease.phase === (run.workerId === undefined ? null : 'running') &&
  lease.runId === run.runId &&
  lease.workerId === (run.workerId ?? null) &&
  !lease.failed &&
  lease.expiresAt > now;
