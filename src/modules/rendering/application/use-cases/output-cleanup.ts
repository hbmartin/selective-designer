import { Result } from '@bloodyowl/boxed';

import type {
  ApplicationResult,
  Clock,
  IdGenerator,
  Logger,
  ObjectStoragePort,
} from '@/modules/kernel';
import { actionableErrorCode } from '@/modules/kernel/domain/errors/actionable-error-code';

import { discardLostOutput } from './pipeline';
import type { OutputCleanupStore } from '../ports/output-cleanup';
import type { ResultOutputReferences } from '../ports/ports';

export type OutputCleanupDeps = {
  store: OutputCleanupStore;
  clock: Clock;
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
  >
> {
  const id = deps.idGenerator.createId();
  if (id.isError()) return Result.Error(id.getError());
  const claimId = id.get();
  const claimed = await deps.store.claim({
    cleanupId,
    claimId,
    now: deps.clock.now(),
  });
  if (claimed.isError()) return Result.Error(claimed.getError());
  const claim = claimed.get();
  if (claim.type === 'cleanup_unavailable') return Result.Ok(claim);
  const { target } = claim;
  const result = await discardLostOutput(
    deps,
    { ...target, workflowRunId: claimId },
    target.objectKey
  );
  const settled = await deps.store.settle({
    cleanupId,
    claimId,
    now: deps.clock.now(),
    outcome: result.isError() ? 'retry' : result.get().type,
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
