import { FatalError, getWorkflowMetadata, sleep } from 'workflow';

import { failureCode } from '@/modules/kernel/domain/errors/failure-code';
import {
  toProviderCallId,
  toRenderResultId,
} from '@/modules/kernel/domain/ids';
import {
  isRetryableAppError,
  unwrapStepResult,
} from '@/modules/kernel/transport/workflow/step-result-mapper';

import type { AcceptedRenderSubmission } from '../../application/ports/ports';

export const MAX_POLLS = 150;
export const pollDelayMs = (poll: number) => Math.min(10, 2 + poll) * 1000;

type Execution = { resultId: string; attempt: number; workflowRunId: string };
const resultIdOrFail = (value: string) => {
  const id = toRenderResultId(value);
  if (id.isError()) throw new FatalError('Invalid render result id');
  return id.get();
};
type PipelineModule = typeof import('@/composition/rendering-pipeline');
let pipelineModule: Promise<PipelineModule> | undefined;
const pipeline = async () => {
  pipelineModule ??= import('@/composition/rendering-pipeline').catch(
    (error: unknown) => {
      pipelineModule = undefined;
      throw error;
    }
  );
  return (await pipelineModule).getRenderingPipelineUseCases();
};

async function submitStep(input: Execution) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).submit({ ...input, resultId: resultIdOrFail(input.resultId) })
  );
}
async function persistSubmissionStep(input: AcceptedRenderSubmission) {
  'use step';
  const result = await (await pipeline()).persistSubmission(input);
  if (result.isOk()) return result.get();
  const error = result.getError();
  return {
    type: 'submission_persistence_error' as const,
    code: error.code,
    retryable: isRetryableAppError(error),
  };
}
persistSubmissionStep.maxRetries = 0;
async function unresolvedSubmissionStep(input: Execution, code: string) {
  'use step';
  (await pipeline()).reportSubmissionUnresolved({
    resultId: input.resultId,
    attempt: input.attempt,
    workflowRunId: input.workflowRunId,
    code,
  });
}

export const persistenceDelayMs = (retry: number) =>
  Math.min(60_000, 5_000 * 2 ** Math.min(retry, 4));

async function recoverSubmission(input: AcceptedRenderSubmission) {
  let retry = 0;
  let code = 'RENDER_SUBMISSION_PERSISTENCE_UNRESOLVED';
  const deadline = Date.parse(input.attemptDeadlineAt);
  while (true) {
    if (!Number.isFinite(deadline) || Date.now() >= deadline) {
      await unresolvedSubmissionStep(input, code);
      return { type: 'result_submission_unresolved' as const };
    }
    let result;
    try {
      // oxlint-disable-next-line no-await-in-loop -- replay the same journaled acceptance.
      result = await persistSubmissionStep(input);
    } catch (error) {
      result = {
        type: 'submission_persistence_error' as const,
        code: failureCode(error, code),
        retryable: true,
      };
    }
    if (result.type !== 'submission_persistence_error') return result;
    code = result.code;
    if (!result.retryable)
      return { type: 'submission_persistence_blocked' as const, code };
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      // oxlint-disable-next-line no-await-in-loop -- durable backoff never extends the attempt deadline.
      await sleep(Math.min(persistenceDelayMs(retry++), remaining));
    }
  }
}
async function dispatchAccountingStep(receiptId: string) {
  'use step';
  return (await pipeline()).dispatchAccounting(
    unwrapStepResult(toProviderCallId(receiptId))
  );
}
async function cleanupOutputStep(cleanupId: string) {
  'use step';
  const { getRenderOutputCleanup } =
    await import('@/composition/render-output-cleanup');
  return unwrapStepResult(await getRenderOutputCleanup().process(cleanupId));
}

async function pollStep(input: Execution & { providerRequestId: string }) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).poll({ ...input, resultId: resultIdOrFail(input.resultId) })
  );
}
async function markFailedStep(
  input: Execution & {
    providerRequestId?: string;
    submissionPersistenceFailure?: true;
  },
  reason: string
) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).markFailed({ ...input, resultId: resultIdOrFail(input.resultId), reason })
  );
}

/** An execution owns one immutable attempt, never whichever attempt is current later. */
async function runResult(input: Execution): Promise<string> {
  let providerRequestId: string | undefined;
  let receiptId: string | undefined;
  const fail = async (reason: string, submissionPersistenceFailure?: true) => {
    const failed = await markFailedStep(
      {
        ...input,
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(submissionPersistenceFailure
          ? { submissionPersistenceFailure }
          : {}),
      },
      reason
    );
    return failed.type === 'result_marked_failed'
      ? 'result_failed'
      : failed.type;
  };
  try {
    const accepted = await submitStep(input);
    if (accepted.type === 'result_accepted')
      receiptId = accepted.submission.accountingIdentity.receipt.id;
    else if (accepted.type === 'result_already_submitted')
      receiptId = accepted.receiptId;
    let submitted:
      | Awaited<ReturnType<typeof recoverSubmission>>
      | Exclude<typeof accepted, { type: 'result_accepted' }>;
    if (accepted.type === 'result_accepted') {
      providerRequestId = accepted.submission.providerRequestId;
      submitted = await recoverSubmission(accepted.submission);
      if (submitted.type === 'submission_persistence_blocked')
        return await fail(submitted.code, true);
    } else submitted = accepted;
    if (
      submitted.type !== 'result_submitted' &&
      submitted.type !== 'result_already_submitted'
    )
      return submitted.type;
    providerRequestId = submitted.providerRequestId;
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      // oxlint-disable-next-line no-await-in-loop -- each answer determines the next poll.
      const result = await pollStep({ ...input, providerRequestId });
      if (result.type !== 'result_pending') return result.type;
      // oxlint-disable-next-line no-await-in-loop -- durable backoff.
      await sleep(pollDelayMs(poll));
    }
    return await fail('timed_out');
  } catch (error) {
    return await fail(failureCode(error, 'render_step_failed'));
  } finally {
    if (receiptId) {
      try {
        await dispatchAccountingStep(receiptId);
      } catch {
        /* Receipt delivery remains recoverable through the daily backstop. */
      }
    }
  }
}

export async function renderWorkflow(input: {
  renderId: string;
  attempts: { resultId: string; attempt: number }[];
}) {
  'use workflow';
  const workflowRunId = getWorkflowMetadata().workflowRunId;
  const outcomes = await Promise.allSettled(
    input.attempts.map((attempt) => runResult({ ...attempt, workflowRunId }))
  );
  return {
    results: outcomes.map((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value : 'result_failed'
    ),
  };
}

export async function renderResultWorkflow(input: {
  resultId: string;
  attempt: number;
  cleanupId?: string;
}) {
  'use workflow';
  const execution = {
    resultId: input.resultId,
    attempt: input.attempt,
    workflowRunId: getWorkflowMetadata().workflowRunId,
  };
  const result = runResult(execution);
  const cleanup = input.cleanupId
    ? cleanupOutputStep(input.cleanupId)
    : Promise.resolve();
  const [rendered] = await Promise.allSettled([result, cleanup]);
  return {
    result: rendered.status === 'fulfilled' ? rendered.value : 'result_failed',
  };
}
