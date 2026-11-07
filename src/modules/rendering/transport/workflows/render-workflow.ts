import { FatalError, getWorkflowMetadata, sleep } from 'workflow';

import { failureCode } from '@/modules/kernel/domain/errors/failure-code';
import { safeErrorDiagnostics } from '@/modules/kernel/domain/errors/safe-error-diagnostics';
import {
  toProviderCallId,
  toRenderResultId,
} from '@/modules/kernel/domain/ids';
import { lazyModule } from '@/modules/kernel/transport/workflow/lazy-module';
import {
  isRetryableAppError,
  unwrapStepResult,
} from '@/modules/kernel/transport/workflow/step-result-mapper';

import type { AcceptedRenderSubmission } from '../../application/ports/ports';
import { SubmissionPersistenceError } from '../../application/ports/submission-persistence-error';

export const MAX_POLLS = 150;
export const pollDelayMs = (poll: number) => Math.min(10, 2 + poll) * 1000;

type Execution = { resultId: string; attempt: number; workflowRunId: string };
const resultIdOrFail = (value: string) => {
  const id = toRenderResultId(value);
  if (id.isError()) throw new FatalError('Invalid render result id');
  return id.get();
};
const loadModule = lazyModule(() => import('@/composition/rendering-pipeline'));
const pipeline = async () =>
  (await loadModule()).getRenderingPipelineUseCases();

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
  if (result.isOk()) return { ...result.get(), receiptCaptured: true };
  const error = result.getError();
  return {
    type: 'submission_persistence_error' as const,
    code: error.code,
    retryable: isRetryableAppError(error),
    receiptCaptured:
      error instanceof SubmissionPersistenceError && error.receiptCaptured,
  };
}
persistSubmissionStep.maxRetries = 0;
async function unresolvedSubmissionStep(
  input: Execution,
  code: string,
  receiptCaptured: boolean
) {
  'use step';
  (await pipeline()).reportSubmissionUnresolved({
    resultId: input.resultId,
    attempt: input.attempt,
    workflowRunId: input.workflowRunId,
    code,
    receiptCapture: receiptCaptured ? 'confirmed' : 'unconfirmed',
  });
}

export const persistenceDelayMs = (retry: number) =>
  Math.min(60_000, 5_000 * 2 ** Math.min(retry, 4));

async function recoverSubmission(input: AcceptedRenderSubmission) {
  let retry = 0;
  let receiptCaptured = false;
  let lastCode = 'RENDER_SUBMISSION_PERSISTENCE_UNRESOLVED';
  const deadline = Date.parse(input.attemptDeadlineAt);
  while (true) {
    let result;
    try {
      // oxlint-disable-next-line no-await-in-loop -- always attempt the journaled acceptance once.
      result = await persistSubmissionStep(input);
    } catch (error) {
      try {
        await persistenceExceptionStep(
          input,
          failureCode(error, lastCode),
          safeErrorDiagnostics(error)
        );
      } catch {
        // Diagnostic delivery must not abandon the journaled acceptance or its capture progress.
      }
      result = {
        type: 'submission_persistence_error' as const,
        code: failureCode(error, lastCode),
        retryable: true,
        receiptCaptured: false,
      };
    }
    if (result.type === 'submission_persistence_error') lastCode = result.code;
    receiptCaptured ||= result.receiptCaptured;
    if (result.type !== 'submission_persistence_error')
      return { ...result, receiptCaptured };
    const code = Number.isFinite(deadline)
      ? result.code
      : 'RENDER_SUBMISSION_DEADLINE_INVALID';
    if (!result.retryable || !Number.isFinite(deadline))
      return {
        type: 'submission_persistence_blocked' as const,
        code,
        receiptCaptured,
      };
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await unresolvedSubmissionStep(input, code, receiptCaptured);
      return { type: 'result_submission_unresolved' as const, receiptCaptured };
    }
    // oxlint-disable-next-line no-await-in-loop -- durable backoff never extends the attempt deadline.
    await sleep(Math.min(persistenceDelayMs(retry++), remaining));
    if (Date.now() >= deadline) {
      await unresolvedSubmissionStep(input, code, receiptCaptured);
      return { type: 'result_submission_unresolved' as const, receiptCaptured };
    }
  }
}
async function persistenceExceptionStep(
  input: AcceptedRenderSubmission,
  errorCode: string,
  diagnostics: ReturnType<typeof safeErrorDiagnostics>
) {
  'use step';
  (await pipeline()).reportSubmissionException({
    resultId: input.resultId,
    attempt: input.attempt,
    workflowRunId: input.workflowRunId,
    code: errorCode,
    ...diagnostics,
  });
}
persistenceExceptionStep.maxRetries = 0;
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
    if (accepted.type === 'result_already_submitted')
      receiptId = accepted.receiptId;
    let submitted:
      | Awaited<ReturnType<typeof recoverSubmission>>
      | Exclude<typeof accepted, { type: 'result_accepted' }>;
    if (accepted.type === 'result_accepted') {
      providerRequestId = accepted.submission.providerRequestId;
      submitted = await recoverSubmission(accepted.submission);
      if ('receiptCaptured' in submitted && submitted.receiptCaptured)
        receiptId = accepted.submission.accountingIdentity.receipt.id;
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
