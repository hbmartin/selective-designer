import { Result } from '@bloodyowl/boxed';
import { describe, expect, it, vi } from 'vitest';
import { FatalError, RetryableError } from 'workflow';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { ObjectCopySourceError } from '@/modules/kernel/domain/errors/object-copy-source-error';
import { unwrapStepResult } from '@/modules/kernel/transport/workflow/step-result-mapper';

const appError = (category: AppError['category'], status: number) =>
  new AppError({ code: 'TEST_FAILURE', category, status, message: 'boom' });

describe('unwrapStepResult', () => {
  it('passes expected outcomes through as plain values', () => {
    expect(unwrapStepResult(Result.Ok({ type: 'render_queued' }))).toEqual({
      type: 'render_queued',
    });
  });

  it('retries transient system and rate-limit failures', () => {
    expect(() =>
      unwrapStepResult(Result.Error(appError('system', 502)))
    ).toThrow(RetryableError);
    expect(() =>
      unwrapStepResult(Result.Error(appError('rate_limit', 429)))
    ).toThrow(RetryableError);
  });

  it('fails fast on non-transient errors', () => {
    expect(() =>
      unwrapStepResult(Result.Error(appError('not_found', 404)))
    ).toThrow(FatalError);
    expect(() =>
      unwrapStepResult(Result.Error(appError('bad_request', 400)))
    ).toThrow('TEST_FAILURE: boom');
  });
});

it('does not retry terminal source errors and propagates provider retry delays', () => {
  expect(() =>
    unwrapStepResult(
      Result.Error(
        new ObjectCopySourceError({
          reason: 'network',
          attempts: 1,
          retryable: false,
          cause: { code: 'ENOTFOUND' },
        })
      )
    )
  ).toThrow(FatalError);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
  let caught: unknown;
  try {
    unwrapStepResult(
      Result.Error(
        new ObjectCopySourceError({
          reason: 'http',
          status: 429,
          attempts: 1,
          retryAfterMs: 120_000,
          cause: undefined,
        })
      )
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RetryableError);
  try {
    expect(caught).toMatchObject({
      retryAfter: new Date('2026-11-05T00:02:00Z'),
    });
  } finally {
    vi.useRealTimers();
  }
});
