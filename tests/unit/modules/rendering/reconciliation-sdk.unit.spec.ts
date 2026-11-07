import { Result } from '@bloodyowl/boxed';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ reconcileSubmission: vi.fn() }));
vi.mock('@/composition/rendering-pipeline', () => ({
  getRenderingPipelineUseCases: () => state,
}));
import { AppError } from '@/modules/kernel';
import type { AcceptedRenderSubmission } from '@/modules/rendering';
import { reconcileSubmissionStep } from '@/modules/rendering/testing';

// Deliberate pinned-SDK contract: exercise its real executor/serialization, not a retry imitation.
// Internal entry points stay confined to this test; an SDK upgrade must revalidate the contract.
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('workflow'));
const sdkRoot = path.dirname(sdkRequire.resolve('@workflow/core/runtime'));
const sdk = (file: string) =>
  import(pathToFileURL(path.join(sdkRoot, file)).href);
const { executeStep } = await sdk('runtime/step-executor.js');
const { registerStepFunction } = await sdk('private.js');
const { dehydrateStepArguments } = await sdk('serialization.js');
const stepName = 'step//reconciliation-contract//reconcileSubmissionStep';

describe('submission reconciliation against the pinned SDK executor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    registerStepFunction(stepName, reconcileSubmissionStep);
  });
  afterEach(() => vi.useRealTimers());

  const execute = async (attempt: number, events: { eventType: string }[]) => {
    const workflowRunId = 'wrun_reconciliation_contract';
    const input = {
      resultId: 'result-1',
      attempt: 1,
      workflowRunId,
    } as AcceptedRenderSubmission;
    const serialized = await dehydrateStepArguments(
      { args: [input] },
      workflowRunId,
      undefined
    );
    return executeStep({
      world: {
        events: {
          create: async (_runId: string, event: { eventType: string }) => {
            events.push(event);
            return {};
          },
        },
      },
      workflowRunId,
      workflowName: 'reconciliation-contract',
      workflowStartedAt: Date.now(),
      stepId: 'step_reconciliation_contract',
      stepName,
      authoritativeAttempt: attempt,
      preclaimedStart: {
        owned: true,
        step: {
          attempt,
          input: serialized,
          startedAt: new Date(),
          status: 'running',
        },
      },
    });
  };
  const unavailable = () =>
    Result.Error(
      new AppError({ code: 'DB_UNAVAILABLE', category: 'system', status: 503 })
    );

  it('retries real transient failures twice at five seconds and then completes the saved request', async () => {
    const events: { eventType: string }[] = [];
    state.reconcileSubmission
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValue(
        Result.Ok({
          type: 'result_submitted',
          providerRequestId: 'paid',
          receiptCaptured: true,
        })
      );
    expect(await execute(1, events)).toEqual({
      type: 'retry',
      timeoutSeconds: 5,
    });
    vi.setSystemTime(Date.now() + 5000);
    expect(await execute(2, events)).toEqual({
      type: 'retry',
      timeoutSeconds: 5,
    });
    vi.setSystemTime(Date.now() + 5000);
    expect(await execute(3, events)).toMatchObject({ type: 'completed' });
    expect(state.reconcileSubmission).toHaveBeenCalledTimes(3);
    expect(events.map((event) => event.eventType)).toEqual([
      'step_retrying',
      'step_retrying',
      'step_completed',
    ]);
  });
  it('exhausts on the third failed read and never executes a fourth', async () => {
    const events: { eventType: string }[] = [];
    state.reconcileSubmission.mockResolvedValue(unavailable());
    expect(await execute(1, events)).toMatchObject({ type: 'retry' });
    expect(await execute(2, events)).toMatchObject({ type: 'retry' });
    expect(await execute(3, events)).toEqual({ type: 'failed' });
    expect(await execute(4, events)).toEqual({ type: 'failed' });
    expect(state.reconcileSubmission).toHaveBeenCalledTimes(3);
  });
  it('does not retry an explicitly permanent reconciliation error', async () => {
    const events: { eventType: string }[] = [];
    state.reconcileSubmission.mockResolvedValue(
      Result.Error(
        new AppError({
          code: 'INVALID_IDENTITY',
          category: 'bad_request',
          status: 400,
          retryable: false,
        })
      )
    );
    expect(await execute(1, events)).toEqual({ type: 'failed' });
    expect(events.map((event) => event.eventType)).toEqual(['step_failed']);
  });
});
