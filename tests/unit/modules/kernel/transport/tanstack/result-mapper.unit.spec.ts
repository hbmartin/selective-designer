import { Result } from '@bloodyowl/boxed';
import { describe, expect, it } from 'vitest';

import {
  AppError,
  type ApplicationResult,
  type OutcomeHandlerConfig,
  ServerFnError,
  unwrapApplicationResult,
} from '@/modules/kernel/testing';

type TestOutcome =
  | { type: 'test_completed'; value: string }
  | { type: 'test_forbidden' };

describe('tanstack result mapper', () => {
  const handlers = {
    test_completed: (outcome) => outcome.value,
    test_forbidden: 'FORBIDDEN',
  } as const satisfies OutcomeHandlerConfig<TestOutcome, string>;

  it('maps successful tagged outcomes', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Ok({ type: 'test_completed' as const, value: 'value' })
        ),
        handlers
      )
    ).resolves.toBe('value');
  });

  it('maps expected business outcomes to server function errors', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(Result.Ok({ type: 'test_forbidden' as const })),
        handlers
      )
    ).rejects.toBeInstanceOf(ServerFnError);
  });

  it('maps app errors to server function errors', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Error(
            new AppError({
              code: 'DUPLICATE',
              category: 'conflict',
              status: 409,
              message: 'Duplicate',
              details: { target: ['email'] },
              exposeDetails: true,
            })
          )
        ),
        handlers
      )
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      data: { target: ['email'] },
    });
  });

  it('hides internal (system) app error messages and details from the client', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Error(
            new AppError({
              code: 'DESIGN_REPOSITORY_ERROR',
              category: 'system',
              status: 500,
              message: 'connection refused: postgres://secret-host:5432',
              details: { query: 'SELECT * FROM users' },
              exposeDetails: true,
            })
          )
        ),
        handlers
      )
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      data: undefined,
    });
  });

  it('hides non-system 5xx app error messages and details from the client', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Error(
            new AppError({
              code: 'UPSTREAM_CONFLICT',
              category: 'conflict',
              status: 503,
              message: 'upstream conflict contained secret details',
              details: { upstream: 'internal-service' },
              exposeDetails: true,
            })
          )
        ),
        handlers
      )
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      data: undefined,
    });
  });

  it('maps thrown app errors for legacy promise boundaries', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.reject(
          new AppError({
            code: 'UNAUTHORIZED',
            category: 'unauthorized',
            status: 401,
            message: 'Unauthorized',
          })
        ) as Promise<ApplicationResult<TestOutcome>>,
        handlers
      )
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
