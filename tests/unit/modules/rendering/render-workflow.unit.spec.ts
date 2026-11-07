import { Result } from '@bloodyowl/boxed';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/modules/kernel';

type Outcome = { type: string; [key: string]: unknown };
const pipeline = vi.hoisted(() => ({
  submit: vi.fn(),
  persistSubmission: vi.fn(),
  cleanup: vi.fn(),
  reportSubmissionUnresolved: vi.fn(),
  dispatchAccounting: vi.fn(),
  poll: vi.fn(),
  markFailed: vi.fn(),
}));
vi.mock('workflow', () => ({
  FatalError: class FatalError extends Error {},
  RetryableError: class RetryableError extends Error {},
  sleep: vi.fn(async () => {}),
  getWorkflowMetadata: () => ({ workflowRunId: 'workflow-1' }),
}));
vi.mock('@/composition/render-output-cleanup', () => ({
  getRenderOutputCleanup: () => ({ process: pipeline.cleanup }),
}));
vi.mock('@/composition/rendering-pipeline', () => ({
  getRenderingPipelineUseCases: () => pipeline,
}));
const { sleep } = await import('workflow');
const { renderResultWorkflow, renderWorkflow, MAX_POLLS, pollDelayMs } =
  await import('@/modules/rendering/testing');
const ok = (value: Outcome) => Promise.resolve(Result.Ok(value));
const attempt = { resultId: 'res-a', attempt: 1 };
const execution = { ...attempt, workflowRunId: 'workflow-1' };

describe('render workflow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T19:00:00Z'));
    vi.mocked(sleep).mockImplementation(async (duration) => {
      vi.setSystemTime(Date.now() + Number(duration));
    });
    pipeline.submit.mockImplementation(() =>
      ok({ type: 'result_submitted', providerRequestId: 'request-1' })
    );
    pipeline.markFailed.mockImplementation(() =>
      ok({ type: 'result_marked_failed' })
    );
  });
  afterEach(() => vi.useRealTimers());
  it('passes the dispatched attempt and workflow ownership to each independent result', async () => {
    pipeline.poll.mockImplementation(({ resultId }) =>
      ok(
        resultId === 'res-a'
          ? { type: 'result_succeeded' }
          : { type: 'result_failed', reason: 'moderated' }
      )
    );
    const actual = await renderWorkflow({
      renderId: 'render-1',
      attempts: [attempt, { resultId: 'res-b', attempt: 2 }],
    });
    expect(actual).toEqual({ results: ['result_succeeded', 'result_failed'] });
    expect(pipeline.submit).toHaveBeenCalledWith(execution);
    expect(pipeline.submit).toHaveBeenCalledWith({
      resultId: 'res-b',
      attempt: 2,
      workflowRunId: 'workflow-1',
    });
    expect(pipeline.poll).toHaveBeenCalledWith({
      ...execution,
      providerRequestId: 'request-1',
    });
    expect(pipeline.markFailed).not.toHaveBeenCalled();
  });
  it('fences a failure even when submission never returned its request id', async () => {
    pipeline.submit.mockResolvedValue(
      Result.Error(
        new AppError({
          code: 'MODEL_UNAVAILABLE',
          category: 'system',
          status: 502,
        })
      )
    );
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_failed',
    });
    expect(pipeline.markFailed).toHaveBeenCalledWith({
      ...execution,
      reason: 'MODEL_UNAVAILABLE',
    });
  });
  it('keeps the original code when the SDK exhausts retries', async () => {
    const original = new Error('OBJECT_COPY_SOURCE_FAILED: safe source error');
    pipeline.poll.mockRejectedValue(
      new Error(
        'Step "pollStep" failed after 3 retries: OBJECT_COPY_SOURCE_FAILED: safe source error',
        { cause: original }
      )
    );
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_failed',
    });
    expect(pipeline.markFailed).toHaveBeenCalledWith({
      ...execution,
      providerRequestId: 'request-1',
      reason: 'OBJECT_COPY_SOURCE_FAILED',
    });
  });
  it('does not report a stale failure as failure of its replacement', async () => {
    pipeline.poll.mockRejectedValue(new Error('lost connection'));
    pipeline.markFailed.mockImplementation(() =>
      ok({ type: 'result_attempt_superseded' })
    );
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_attempt_superseded',
    });
    expect(pipeline.markFailed).toHaveBeenCalledWith({
      ...execution,
      providerRequestId: 'request-1',
      reason: 'render_step_failed',
    });
  });
  it('stops a superseded submission before polling', async () => {
    pipeline.submit.mockImplementation(() =>
      ok({ type: 'result_attempt_superseded' })
    );
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_attempt_superseded',
    });
    expect(pipeline.poll).not.toHaveBeenCalled();
  });
  it('fences the timeout by the original attempt and provider request', async () => {
    pipeline.poll.mockImplementation(() => ok({ type: 'result_pending' }));
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_failed',
    });
    expect(pipeline.poll).toHaveBeenCalledTimes(MAX_POLLS);
    expect(pipeline.markFailed).toHaveBeenCalledWith({
      ...execution,
      providerRequestId: 'request-1',
      reason: 'timed_out',
    });
  });
  it('retries journaled acceptance until the original deadline without resubmitting', async () => {
    const submission = {
      ...execution,
      providerRequestId: 'accepted-request',
      attemptDeadlineAt: '2026-11-06T19:30:00.000Z',
      accountingIdentity: { receipt: { id: 'accepted-call' } },
    };
    pipeline.submit.mockResolvedValue(
      Result.Ok({ type: 'result_accepted', submission })
    );
    pipeline.persistSubmission.mockRejectedValue(
      new Error('Step persistSubmissionStep failed after 3 retries')
    );
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_submission_unresolved',
    });
    expect(pipeline.persistSubmission).toHaveBeenCalledWith(submission);
    expect(pipeline.dispatchAccounting).toHaveBeenCalledWith('accepted-call');
    expect(pipeline.submit).toHaveBeenCalledTimes(1);
    expect(pipeline.poll).not.toHaveBeenCalled();
    expect(pipeline.markFailed).not.toHaveBeenCalled();
  });
  it('recovers a database outage with durable 5, 10 and 20 second backoff', async () => {
    const submission = {
      ...execution,
      providerRequestId: 'accepted-request',
      attemptDeadlineAt: '2026-11-06T19:30:00.000Z',
      accountingIdentity: { receipt: { id: 'accepted-call' } },
    };
    pipeline.submit.mockResolvedValue(
      Result.Ok({ type: 'result_accepted', submission })
    );
    const unavailable = Result.Error(
      new AppError({ code: 'DB_DOWN', category: 'system', status: 503 })
    );
    pipeline.persistSubmission
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValue(
        Result.Ok({
          type: 'result_submitted',
          providerRequestId: 'accepted-request',
        })
      );
    pipeline.poll.mockResolvedValue(Result.Ok({ type: 'result_succeeded' }));
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_succeeded',
    });
    expect(vi.mocked(sleep).mock.calls).toEqual([[5000], [10000], [20000]]);
    expect(pipeline.submit).toHaveBeenCalledTimes(1);
    expect(pipeline.persistSubmission).toHaveBeenCalledTimes(4);
    expect(pipeline.poll).toHaveBeenCalledWith({
      ...execution,
      providerRequestId: 'accepted-request',
    });
  });
  it('fails an owned accepted attempt immediately on a permanent identity error', async () => {
    pipeline.submit.mockResolvedValue(
      Result.Ok({
        type: 'result_accepted',
        submission: {
          ...execution,
          providerRequestId: 'accepted-request',
          attemptDeadlineAt: '2026-11-06T19:30:00.000Z',
          accountingIdentity: { receipt: { id: 'accepted-call' } },
        },
      })
    );
    pipeline.persistSubmission.mockResolvedValue(
      Result.Error(
        new AppError({
          code: 'PROVIDER_RECEIPT_IDENTITY_MISMATCH',
          category: 'system',
          status: 500,
          retryable: false,
        })
      )
    );
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_failed',
    });
    expect(pipeline.persistSubmission).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(pipeline.markFailed).toHaveBeenCalledWith({
      ...execution,
      providerRequestId: 'accepted-request',
      submissionPersistenceFailure: true,
      reason: 'PROVIDER_RECEIPT_IDENTITY_MISMATCH',
    });
  });
  it('clamps its last wait to the deadline and never marks transient exhaustion failed', async () => {
    pipeline.submit.mockResolvedValue(
      Result.Ok({
        type: 'result_accepted',
        submission: {
          ...execution,
          providerRequestId: 'accepted-request',
          attemptDeadlineAt: '2026-11-06T19:00:03.000Z',
          accountingIdentity: { receipt: { id: 'accepted-call' } },
        },
      })
    );
    pipeline.persistSubmission.mockResolvedValue(
      Result.Error(
        new AppError({ code: 'DB_DOWN', category: 'system', status: 503 })
      )
    );
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_submission_unresolved',
    });
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(pipeline.persistSubmission).toHaveBeenCalledTimes(1);
    expect(pipeline.markFailed).not.toHaveBeenCalled();
    expect(pipeline.reportSubmissionUnresolved).toHaveBeenCalledWith({
      ...execution,
      code: 'DB_DOWN',
    });
  });
  it('starts polling before dispatch and dispatches only after output completion', async () => {
    const submission = {
      ...execution,
      providerRequestId: 'accepted-request',
      attemptDeadlineAt: '2026-11-06T19:30:00.000Z',
      accountingIdentity: { receipt: { id: 'accepted-call' } },
    };
    pipeline.submit.mockResolvedValue(
      Result.Ok({ type: 'result_accepted', submission })
    );
    pipeline.persistSubmission.mockResolvedValue(
      Result.Ok({
        type: 'result_submitted',
        providerRequestId: 'accepted-request',
      })
    );
    pipeline.poll.mockImplementation(async () => {
      expect(pipeline.dispatchAccounting).not.toHaveBeenCalled();
      return Result.Ok({ type: 'result_succeeded' });
    });
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_succeeded',
    });
    expect(pipeline.poll).toHaveBeenCalledBefore(pipeline.dispatchAccounting);
    expect(pipeline.dispatchAccounting).toHaveBeenCalledWith('accepted-call');
  });
  it('preserves publication when post-publication dispatch exhausts', async () => {
    pipeline.submit.mockResolvedValue(
      Result.Ok({
        type: 'result_already_submitted',
        providerRequestId: 'request-1',
        receiptId: 'accepted-call',
      })
    );
    pipeline.poll.mockResolvedValue(Result.Ok({ type: 'result_succeeded' }));
    pipeline.dispatchAccounting.mockRejectedValue(
      new Error('Step dispatchAccountingStep failed')
    );
    expect(await renderResultWorkflow(attempt)).toEqual({
      result: 'result_succeeded',
    });
    expect(pipeline.markFailed).not.toHaveBeenCalled();
  });
  it('continues the replacement while cleanup fails', async () => {
    pipeline.poll.mockResolvedValue(Result.Ok({ type: 'result_succeeded' }));
    pipeline.cleanup.mockRejectedValue(new Error('cleanup unavailable'));
    expect(
      await renderResultWorkflow({
        ...attempt,
        cleanupId: 'results/res-a/1/raw.png',
      })
    ).toEqual({ result: 'result_succeeded' });
    expect(pipeline.submit).toHaveBeenCalledBefore(pipeline.cleanup);
    expect(pipeline.cleanup).toHaveBeenCalledWith('results/res-a/1/raw.png');
  });
  it('backs off from 2 s to 10 s', () => {
    expect([0, 1, 5, 8, 100].map(pollDelayMs)).toEqual([
      2000, 3000, 7000, 10_000, 10_000,
    ]);
  });
});
