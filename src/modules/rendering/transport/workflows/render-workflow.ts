import { FatalError, sleep } from 'workflow';

import { toRenderId, toRenderResultId } from '@/modules/kernel/domain/ids';
import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';

/** Poll for up to ~25 minutes; models usually answer in 10–120 s. */
export const MAX_POLLS = 150;
export const pollDelayMs = (poll: number) => Math.min(10, 2 + poll) * 1000;

const renderIdOrFail = (value: string) => {
  const id = toRenderId(value);
  if (id.isError()) throw new FatalError(`Invalid render id: ${value}`);
  return id.get();
};
const resultIdOrFail = (value: string) => {
  const id = toRenderResultId(value);
  if (id.isError()) throw new FatalError(`Invalid render result id: ${value}`);
  return id.get();
};

type PipelineModule = typeof import('@/composition/rendering-pipeline');
let pipelineModule: Promise<PipelineModule> | undefined;

/** Lazily loaded once per process (steps run concurrently). */
const pipeline = async () => {
  pipelineModule ??= import('@/composition/rendering-pipeline').catch(
    (error: unknown) => {
      pipelineModule = undefined;
      throw error;
    }
  );
  return (await pipelineModule).getRenderingPipelineUseCases();
};

async function runnableStep(renderId: string) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).runnable(renderIdOrFail(renderId))
  );
}

async function submitStep(resultId: string) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).submit(resultIdOrFail(resultId))
  );
}

async function pollStep(resultId: string) {
  'use step';
  return unwrapStepResult(
    await (await pipeline()).poll(resultIdOrFail(resultId))
  );
}

async function markFailedStep(resultId: string, reason: string) {
  'use step';
  return unwrapStepResult(
    await (
      await pipeline()
    ).markFailed({ resultId: resultIdOrFail(resultId), reason })
  );
}

const failureReason = (error: unknown) =>
  error instanceof Error ? error.message : 'render_step_failed';

/**
 * One model's run: submit, then poll until done. Any step that fails for good
 * (retries exhausted, fatal error) or a timeout marks only this result failed.
 */
async function runResult(resultId: string): Promise<string> {
  try {
    const submitted = await submitStep(resultId);
    if (
      submitted.type === 'result_failed' ||
      submitted.type === 'result_not_runnable'
    ) {
      return submitted.type;
    }
    for (let poll = 0; poll < MAX_POLLS; poll += 1) {
      // Sequential by design: each poll waits for the previous answer.
      // oxlint-disable-next-line no-await-in-loop
      const polled = await pollStep(resultId);
      if (polled.type !== 'result_pending') return polled.type;
      // oxlint-disable-next-line no-await-in-loop
      await sleep(pollDelayMs(poll));
    }
    await markFailedStep(resultId, 'timed_out');
    return 'result_failed';
  } catch (error) {
    await markFailedStep(resultId, failureReason(error));
    return 'result_failed';
  }
}

/** Every runnable result of a render, each independent of the others. */
export async function renderWorkflow(input: { renderId: string }) {
  'use workflow';
  const runnable = await runnableStep(input.renderId);
  const outcomes = await Promise.allSettled(
    runnable.resultIds.map((id) => runResult(id))
  );
  return {
    results: outcomes.map((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value : 'result_failed'
    ),
  };
}

/** Retry of a single result (a new attempt). */
export async function renderResultWorkflow(input: { resultId: string }) {
  'use workflow';
  return { result: await runResult(input.resultId) };
}
