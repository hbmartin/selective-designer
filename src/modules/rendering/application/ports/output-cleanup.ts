import type { ApplicationResult } from '@/modules/kernel';

import type { RenderOutputTarget } from '../../domain/render-output-target';

export interface OutputCleanupStore {
  enqueue(
    target: RenderOutputTarget,
    now: Date
  ): Promise<ApplicationResult<{ type: 'cleanup_queued'; cleanupId: string }>>;
  list(input: {
    before: Date;
    after?: string;
    limit: number;
  }): Promise<ApplicationResult<{ type: 'cleanup_listed'; ids: string[] }>>;
  claim(input: {
    cleanupId: string;
    claimId: string;
    now: Date;
  }): Promise<
    ApplicationResult<
      | { type: 'cleanup_claimed'; target: RenderOutputTarget }
      | { type: 'cleanup_unavailable' }
    >
  >;
  settle(input: {
    cleanupId: string;
    claimId: string;
    now: Date;
    outcome: 'output_deleted' | 'output_retained' | 'retry';
    code?: string;
  }): Promise<
    ApplicationResult<
      { type: 'cleanup_settled' } | { type: 'cleanup_superseded' }
    >
  >;
}
