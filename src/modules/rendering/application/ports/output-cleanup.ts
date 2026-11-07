import type { ApplicationResult } from '@/modules/kernel';
import type { RenderResultId } from '@/modules/kernel/domain/ids';

import type { RenderOutputTarget } from '../../domain/render-output-target';

export type CleanupCursor = { nextAttemptAt: string; objectKey: string };
export type CleanupBlocked = { type: 'cleanup_blocked'; reasonCode: string };
export interface OutputCleanupStore {
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
      blocked: number;
      reasons: { code: string; count: number }[];
    }>
  >;
  list(input: {
    before: string;
    after?: CleanupCursor;
    limit: number;
  }): Promise<
    ApplicationResult<{
      type: 'cleanup_listed';
      ids: string[];
      cursor?: CleanupCursor;
    }>
  >;
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
    outcome: 'output_deleted' | 'output_retained' | 'retry' | 'blocked';
    code?: string;
  }): Promise<
    ApplicationResult<
      { type: 'cleanup_settled' } | { type: 'cleanup_superseded' }
    >
  >;
}
