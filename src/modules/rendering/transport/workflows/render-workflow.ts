import { FatalError, getWorkflowMetadata, sleep } from 'workflow';

import { failureCode } from '@/modules/kernel/domain/errors/failure-code';
import { toObjectKey, toRenderResultId } from '@/modules/kernel/domain/ids';
import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';

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
  return unwrapStepResult(await (await pipeline()).persistSubmission(input));
}
async function cleanupOutputStep(objectKey: string, input: Execution) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).discardOutput({
      ...input,
      resultId: resultIdOrFail(input.resultId),
      objectKey: unwrapStepResult(toObjectKey(objectKey)),
    })
  );
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
  input: Execution & { providerRequestId?: string },
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
  const fail = async (reason: string) => {
    const failed = await markFailedStep(
      { ...input, ...(providerRequestId ? { providerRequestId } : {}) },
      reason
    );
    return failed.type === 'result_marked_failed'
      ? 'result_failed'
      : failed.type;
  };
  try {
    const accepted = await submitStep(input);
    let submitted:
      | Awaited<ReturnType<typeof persistSubmissionStep>>
      | Exclude<typeof accepted, { type: 'result_accepted' }>;
    if (accepted.type === 'result_accepted') {
      providerRequestId = accepted.submission.providerRequestId;
      try {
        submitted = await persistSubmissionStep(accepted.submission);
      } catch {
        // Acceptance is durable; preserve this attempt and its existing Retry deadline.
        return 'result_submission_unresolved';
      }
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
    return fail(failureCode(error, 'render_step_failed'));
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
  replacedObjectKey?: string;
}) {
  'use workflow';
  const execution = {
    resultId: input.resultId,
    attempt: input.attempt,
    workflowRunId: getWorkflowMetadata().workflowRunId,
  };
  const result = runResult(execution);
  const cleanup = input.replacedObjectKey
    ? cleanupOutputStep(input.replacedObjectKey, execution)
    : Promise.resolve();
  const [rendered] = await Promise.allSettled([result, cleanup]);
  return {
    result: rendered.status === 'fulfilled' ? rendered.value : 'result_failed',
  };
}
