import { describe, expect, it } from 'vitest';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { appErrorToResponse } from '@/modules/kernel/transport/http/error-mapper';

describe('appErrorToResponse', () => {
  it('exposes client-error messages and opt-in details', async () => {
    const response = appErrorToResponse(
      new AppError({
        code: 'INVALID_SIGNATURE',
        category: 'bad_request',
        status: 400,
        message: 'Invalid webhook signature',
        details: { header: 'svix-id' },
        exposeDetails: true,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: 'INVALID_SIGNATURE',
      category: 'bad_request',
      message: 'Invalid webhook signature',
      details: { header: 'svix-id' },
    });
  });

  it('hides internal (system) messages and details from the client', async () => {
    const response = appErrorToResponse(
      new AppError({
        code: 'DB_ERROR',
        category: 'system',
        status: 500,
        message: 'connection refused: postgres://secret-host:5432',
        details: { query: 'SELECT 1' },
        exposeDetails: true,
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: 'DB_ERROR',
      category: 'system',
      message: 'Internal server error',
    });
  });

  it('hides non-system 5xx messages and details from the client', async () => {
    const response = appErrorToResponse(
      new AppError({
        code: 'UPSTREAM_CONFLICT',
        category: 'conflict',
        status: 503,
        message: 'upstream conflict contained secret details',
        details: { upstream: 'internal-service' },
        exposeDetails: true,
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: 'UPSTREAM_CONFLICT',
      category: 'conflict',
      message: 'Internal server error',
    });
  });

  it('maps unknown errors to a generic 500', async () => {
    const response = appErrorToResponse(new Error('raw stack details'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      category: 'system',
      message: 'Internal server error',
    });
  });
});
