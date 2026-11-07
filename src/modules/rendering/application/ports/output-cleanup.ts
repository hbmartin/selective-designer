import type { ApplicationResult } from '@/modules/kernel';
import type { RenderResultId } from '@/modules/kernel/domain/ids';

import type { RenderOutputTarget } from '../../domain/render-output-target';

export type CleanupCursor = { nextAttemptAt: string; objectKey: string };
export type CleanupBlocked = { type: 'cleanup_blocked'; reasonCode: string };
export type CleanupPage =
  | { type: 'cleanup_empty'; ids: [] }
  | { type: 'cleanup_page'; ids: [string, ...string[]]; cursor: CleanupCursor };
export type BlockedCleanupRecord = {
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
        | 'cleanup_repair_conflict';
    };
export type CleanupClaim =
  | { type: 'cleanup_claimed'; target: RenderOutputTarget }
  | { type: 'cleanup_unavailable' }
  | CleanupBlocked;
export interface OutputCleanupStore {
  blocked(limit: number): Promise<
    ApplicationResult<{
      type: 'blocked_cleanup_list';
      records: BlockedCleanupRecord[];
    }>
  >;
  inspect(fingerprint: string): Promise<
    ApplicationResult<
      | { type: 'blocked_not_found' }
      | {
          type: 'blocked_cleanup_found';
          record: BlockedCleanupRecord;
          locator: string | null;
          recoveries: {
            requestId: string;
            resultId: string;
            attempt: number;
            createdAt: Date;
            outcome: string;
            previousOutcome: string | null;
            previousCompletedAt: Date | null;
          }[];
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
