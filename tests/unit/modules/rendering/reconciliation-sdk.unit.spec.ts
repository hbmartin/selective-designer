import { Result } from '@bloodyowl/boxed';
import {
  createFakeObjectStorage,
  createFakeProviderCallLog,
} from '@tests/support/fake-kernel-ports';
import { createFakeRenderRepository } from '@tests/support/fake-render-repository';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  reconcileSubmission: vi.fn(),
  facade: undefined as RenderingPipelineUseCases | undefined,
}));
vi.mock('@/composition/rendering-pipeline', () => ({
  getRenderingPipelineUseCases: () => state.facade,
}));
import { AppError } from '@/modules/kernel';
import { toGeneratedId } from '@/modules/kernel/domain/ids';
import {
  type AcceptedRenderSubmission,
  createRenderingPipelineUseCases,
  type RenderingPipelineUseCases,
} from '@/modules/rendering';
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
    const unused = async () =>
      Result.Error(
        new AppError({
          code: 'UNEXPECTED_PORT_CALL',
          category: 'system',
          status: 500,
        })
      );
    state.facade = createRenderingPipelineUseCases({
      renderRepository: {
        ...createFakeRenderRepository(() => new Date()).repository,
        reconcileSubmission: state.reconcileSubmission,
      },
      renderInputs: { sourceImage: unused, item: unused, region: unused },
      maskCompositor: { composeEditMask: unused, maskForModel: unused },
      imageModels: { adapterFor: () => ({ submit: unused, poll: unused }) },
      resultImages: { findRegistered: unused, register: unused },
      resultOutputReferences: { check: unused },
      objectStorage: createFakeObjectStorage().storage,
      providerAccounting: createFakeProviderCallLog().accounting,
      idGenerator: { createId: () => toGeneratedId('sdk-fixture') },
      clock: { now: () => new Date() },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
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
  it('does not retry a permanent invalid-row port error through the application factory and actual SDK executor', async () => {
    const events: { eventType: string }[] = [];
    state.reconcileSubmission.mockResolvedValue(
      Result.Error(
        new AppError({
          code: 'RENDER_ROW_INVALID',
          category: 'system',
          status: 500,
          retryable: false,
        })
      )
    );
    expect(await execute(1, events)).toEqual({ type: 'failed' });
    expect(state.reconcileSubmission).toHaveBeenCalledOnce();
    expect(events.map((event) => event.eventType)).toEqual(['step_failed']);
  });
});
