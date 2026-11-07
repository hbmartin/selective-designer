import type { ApplicationResult } from '@/modules/kernel';
import type { RenderResultId } from '@/modules/kernel/domain/ids';

import type { RenderOutputTarget } from '../../domain/render-output-target';

export type CleanupCursor = { nextAttemptAt: string; objectKey: string };
export type CleanupBlocked = { type: 'cleanup_blocked'; reasonCode: string };
export type CleanupPage =
  | { type: 'cleanup_empty'; ids: [] }
  | { type: 'cleanup_page'; ids: [string, ...string[]]; cursor: CleanupCursor };
export type BlockedCursor = { createdAt: string; fingerprint: string };
export type BlockedListInput = {
  limit: number;
  after?: BlockedCursor;
  outstanding?: boolean;
};
export type CleanupAcknowledgmentInput = {
  requestId: string;
  fingerprint: string;
};
export type CleanupAcknowledgmentOutcome =
  | { type: 'cleanup_acknowledged'; requestId: string }
  | {
      type:
        | 'blocked_not_found'
        | 'locator_available'
        | 'cleanup_repair_conflict';
    };
export type BlockedCleanupRecord = {
  intervention: 'outstanding' | 'handed_off' | 'acknowledged';
  fingerprint: string;
  resultId: string | null;
  attempt: number | null;
  reasonCode: string;
  createdAt: Date;
};
export type CleanupRepairInput = {
  requestId: string;
  fingerprint: string;
  resultId: RenderResultId;
  attempt: number;
};
export type CleanupRepairOutcome =
  | {
      type:
        | 'cleanup_requeued'
        | 'cleanup_already_pending'
        | 'cleanup_already_completed';
      requestId: string;
    }
  | {
      type:
        | 'blocked_not_found'
        | 'locator_unavailable'
        | 'cleanup_target_mismatch'
        | 'cleanup_repair_conflict'
        | 'cleanup_attempt_active'
        | 'cleanup_attempt_invalid';
    };
export type CleanupClaim =
  | { type: 'cleanup_claimed'; target: RenderOutputTarget }
  | { type: 'cleanup_unavailable' }
  | CleanupBlocked;
export type CleanupRecoveryEvent = { requestId: string; createdAt: Date } & (
  | {
      outcome: 'cleanup_acknowledged';
      reasonCode: 'locator_unavailable_retained';
    }
  | {
      outcome:
        | 'cleanup_requeued'
        | 'cleanup_already_pending'
        | 'cleanup_already_completed';
      resultId: string;
      attempt: number;
      previousOutcome: string | null;
      previousCompletedAt: Date | null;
    }
);
export interface OutputCleanupStore {
  acknowledge(
    input: CleanupAcknowledgmentInput
  ): Promise<ApplicationResult<CleanupAcknowledgmentOutcome>>;
  blocked(input: number | BlockedListInput): Promise<
    ApplicationResult<{
      type: 'blocked_cleanup_list';
      records: BlockedCleanupRecord[];
      pagination:
        | { type: 'blocked_more'; cursor: BlockedCursor }
        | { type: 'blocked_end' };
    }>
  >;
  inspect(fingerprint: string): Promise<
    ApplicationResult<
      | { type: 'blocked_not_found' }
      | {
          type: 'blocked_cleanup_found';
          record: BlockedCleanupRecord;
          locator: string | null;
          recoveries: CleanupRecoveryEvent[];
        }
    >
  >;
  requeue(
    input: CleanupRepairInput
  ): Promise<ApplicationResult<CleanupRepairOutcome>>;
  enqueue(target: {
    resultId: RenderResultId;
    attempt: number;
    objectKey: unknown;
  }): Promise<
    ApplicationResult<
      { type: 'cleanup_queued'; cleanupId: string } | CleanupBlocked
    >
  >;
  cutoff(): Promise<
    ApplicationResult<{ type: 'cleanup_cutoff'; before: string }>
  >;
  summary(): Promise<
    ApplicationResult<{
      type: 'cleanup_summary';
      blockedTotal: number;
      blockedOutstanding: number;
      outstandingReasons: { code: string; count: number }[];
      reasons: { code: string; count: number }[];
    }>
  >;
  list(input: {
    before: string;
    after?: CleanupCursor;
    limit: number;
  }): Promise<ApplicationResult<CleanupPage>>;
  claim(input: {
    cleanupId: string;
    claimId: string;
  }): Promise<
    ApplicationResult<
      | { type: 'cleanup_claimed'; target: RenderOutputTarget }
      | { type: 'cleanup_unavailable' }
      | CleanupBlocked
    >
  >;
  settle(input: {
    cleanupId: string;
    claimId: string;
    outcome: 'output_deleted' | 'output_retained' | 'retry';
    code?: string;
  }): Promise<
    ApplicationResult<
      { type: 'cleanup_settled' } | { type: 'cleanup_superseded' }
    >
  >;
}
