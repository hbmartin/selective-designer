import { Result } from '@bloodyowl/boxed';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const pipeline = vi.hoisted(() => ({
  submit: vi.fn(),
  poll: vi.fn(),
  markFailed: vi.fn(),
  dispatchAccounting: vi.fn(),
}));

const emitLog = vi.hoisted(() => vi.fn());
vi.mock('@/composition/telemetry/sentry.server', () => ({
  initTelemetryServer: () => ({
    destinations: [
      async (record: unknown) => {
        emitLog(record);
        return true;
      },
    ],
  }),
}));

// Exercise the real logger, production configuration and diagnostic composition.
vi.unmock('@/modules/kernel/infrastructure/logger/telemetry');
vi.mock('@/composition/rendering-pipeline', () => ({
  getRenderingPipelineUseCases: () => pipeline,
}));
vi.mock('workflow', () => ({
  FatalError: class FatalError extends Error {},
  RetryableError: class RetryableError extends Error {},
  sleep: vi.fn(),
  getWorkflowMetadata: () => ({ workflowRunId: 'workflow-1' }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('LOGGER_LEVEL', undefined);
  vi.stubEnv('LOGGER_CONSOLE_MIRROR', undefined);
  vi.stubEnv('LOGGER_PRETTY', undefined);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
});

afterEach(() => {
  try {
    vi.unstubAllEnvs();
  } finally {
    vi.useRealTimers();
    vi.resetModules();
  }
});

it.each(
  (['single', 'batch'] as const).flatMap((entry) =>
    [false, true].map((retryable) => ({ entry, retryable }))
  )
)(
  'emits the final $entry unresolved failure with production defaults and retryable=$retryable',
  async ({ entry, retryable }) => {
    const { AppError } = await import('@/modules/kernel');
    const { sleep } = await import('workflow');
    const { renderResultWorkflow, renderWorkflow } =
      await import('@/modules/rendering/testing');
    vi.mocked(sleep).mockImplementation(async (duration) => {
      vi.setSystemTime(Date.now() + Number(duration));
    });
    pipeline.submit.mockResolvedValue(
      Result.Ok({
        type: 'result_already_submitted',
        providerRequestId: 'private-provider-locator',
        receiptId: 'confirmed',
      })
    );
    pipeline.poll.mockRejectedValue(
      Object.assign(new Error('private provider failure'), {
        code: 'PROVIDER_UNAVAILABLE',
      })
    );
    pipeline.markFailed.mockResolvedValue(
      Result.Error(
        new AppError({
          code: 'DB_UNAVAILABLE',
          category: 'system',
          status: 503,
          retryable,
          message: 'private database failure',
        })
      )
    );
    const attempt = { resultId: 'result-1', attempt: 1 };
    if (entry === 'single') {
      expect(await renderResultWorkflow(attempt)).toEqual({
        result: 'result_failure_persistence_unresolved',
      });
    } else {
      expect(
        await renderWorkflow({ renderId: 'render-1', attempts: [attempt] })
      ).toEqual({ results: ['result_failure_persistence_unresolved'] });
    }
    // Production's default error threshold filters intermediate warnings.
    expect(emitLog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: 'rendering.result.failure_persistence_unresolved',
        level: 'error',
        details: {
          ...attempt,
          workflowRunId: 'workflow-1',
          reason: 'PROVIDER_UNAVAILABLE',
          receiptCapture: 'confirmed',
          code: 'DB_UNAVAILABLE',
          errorNames: ['AppError'],
          errorCodes: ['DB_UNAVAILABLE'],
        },
      })
    );
    expect(JSON.stringify(emitLog.mock.calls)).not.toContain('private');
    expect(pipeline.markFailed).toHaveBeenCalledTimes(retryable ? 5 : 1);
    expect(pipeline.dispatchAccounting).toHaveBeenCalledExactlyOnceWith(
      'confirmed'
    );
  }
);
