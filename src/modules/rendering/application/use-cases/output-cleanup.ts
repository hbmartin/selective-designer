import { Result } from '@bloodyowl/boxed';

import type {
  ApplicationResult,
  IdGenerator,
  Logger,
  ObjectStoragePort,
} from '@/modules/kernel';
import { actionableErrorCode } from '@/modules/kernel/domain/errors/actionable-error-code';

import { discardLostOutput } from './pipeline';
import type {
  CleanupCursor,
  OutputCleanupStore,
} from '../ports/output-cleanup';
import type { ResultOutputReferences } from '../ports/ports';

export type OutputCleanupDeps = {
  store: OutputCleanupStore;
  idGenerator: IdGenerator;
  logger: Logger;
  objectStorage: ObjectStoragePort;
  resultOutputReferences: ResultOutputReferences;
};
export async function cleanupRenderOutput(
  deps: OutputCleanupDeps,
  cleanupId: string
): Promise<
  ApplicationResult<
    | { type: 'cleanup_unavailable' }
    | { type: 'cleanup_completed' }
    | { type: 'cleanup_superseded' }
    | { type: 'cleanup_blocked'; reasonCode: string }
  >
> {
  const id = deps.idGenerator.createId();
  if (id.isError()) return Result.Error(id.getError());
  const claimId = id.get();
  const claimed = await deps.store.claim({
    cleanupId,
    claimId,
  });
  if (claimed.isError()) return Result.Error(claimed.getError());
  const claim = claimed.get();
  if (claim.type !== 'cleanup_claimed') {
    if (claim.type === 'cleanup_blocked')
      deps.logger.warn({
        event: 'rendering.cleanup.blocked',
        details: { code: claim.reasonCode },
      });
    return Result.Ok(claim);
  }
  const { target } = claim;
  const result = await discardLostOutput(
    deps,
    { ...target, workflowRunId: claimId },
    target.objectKey
  );
  const settled = await deps.store.settle({
    cleanupId,
    claimId,
    outcome: result.isError()
      ? result.getError().code === 'RENDER_OUTPUT_TARGET_INVALID'
        ? 'blocked'
        : 'retry'
      : result.get().type,
    ...(result.isError()
      ? {
          code: actionableErrorCode(
            result.getError(),
            'RENDER_OUTPUT_CLEANUP_FAILED'
          ),
        }
      : {}),
  });
  if (settled.isError())
    deps.logger.warn({
      event: 'rendering.cleanup.settle_failed',
      details: {
        resultId: target.resultId,
        attempt: target.attempt,
        code: settled.getError().code,
      },
    });
  if (result.isError()) return Result.Error(result.getError());
  if (settled.isError()) return Result.Error(settled.getError());
  return Result.Ok({
    type:
      settled.get().type === 'cleanup_superseded'
        ? ('cleanup_superseded' as const)
        : ('cleanup_completed' as const),
  });
}

export function createRenderOutputCleanup(deps: OutputCleanupDeps) {
  return {
    process: (cleanupId: string) => cleanupRenderOutput(deps, cleanupId),
    list: (input: { before: string; after?: CleanupCursor }) =>
      deps.store.list({ ...input, limit: 100 }),
    cutoff: () => deps.store.cutoff(),
    summary: async () => {
      const summary = await deps.store.summary();
      if (summary.isOk())
        deps.logger.info({
          event: 'rendering.cleanup.summary',
          details: {
            blocked: summary.get().blocked,
            reasons: summary.get().reasons,
          },
        });
      return summary;
    },
  };
}
