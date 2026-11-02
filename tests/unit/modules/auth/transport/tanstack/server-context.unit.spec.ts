import { Result } from '@bloodyowl/boxed';
import { getGlobalStartContext } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import {
  mockGetSession,
  mockLogger,
  mockSession,
  mockUser,
} from '@tests/server/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createServerContextTools,
  withPublicContext,
} from '@/modules/auth/backend';
import { toUserId } from '@/modules/kernel';
import { ServerFnError } from '@/modules/kernel/client';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { createNoOpTelemetry } from '@/platform/telemetry';

const getGlobalStartContextMock = vi.mocked(getGlobalStartContext);

beforeEach(() => {
  getGlobalStartContextMock.mockReturnValue(undefined as never);
});

describe('server function middleware', () => {
  it('finalizes server timing on handled error paths', async () => {
    await expect(
      withPublicContext(async () => {
        throw new ServerFnError('BAD_REQUEST');
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    expect(setResponseHeader).toHaveBeenCalledWith(
      'Server-Timing',
      expect.stringContaining('global;dur=')
    );
  });

  it('sets protected cache headers and request scope for authenticated server functions', async () => {
    await expect(
      withPublicContext(async (ctx) => ({
        scope: ctx.scope,
        userId: ctx.user?.id,
      }))
    ).resolves.toEqual({
      scope: {
        userId: 'user-1',
        role: 'user',
      },
      userId: 'user-1',
    });

    expect(setResponseHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store'
    );
    expect(setResponseHeader).toHaveBeenCalledWith(
      'Vary',
      'Cookie, Authorization'
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'server_fn.request.finish',
        requestId: expect.any(String),
        sessionId: 'session-1',
        scopeKey: 'user:user-1:role:user',
        userId: 'user-1',
      })
    );
  });

  it('binds authenticated users through the telemetry adapter', async () => {
    const telemetry = {
      ...createNoOpTelemetry(),
      captureException: vi.fn(),
      setUser: vi.fn(),
      startSpan: vi.fn((_options, fn) => fn()),
    };
    const getCurrentSession = vi.fn(async () =>
      Result.Ok({
        type: 'auth_session_found' as const,
        session: {
          session: mockSession,
          user: mockUser,
        },
      })
    );
    const tools = createServerContextTools({
      getAuthUseCases: () =>
        ({
          getCurrentSession,
          checkPermission: vi.fn(),
        }) as ExplicitAny,
      telemetry,
    });

    await expect(tools.withPublicContext(async () => 'ok')).resolves.toBe('ok');

    expect(telemetry.setUser).toHaveBeenCalledWith({
      id: 'user-1',
      email: 'user@example.com',
      role: 'user',
    });
  });

  it('uses Start request auth context and request id when available', async () => {
    const getSession = vi.fn(async () => ({
      session: mockSession,
      user: mockUser,
    }));
    const getCurrentSession = vi.fn();
    getGlobalStartContextMock.mockReturnValue({
      auth: { getSession },
      requestId: 'request-1',
    } as never);
    const tools = createServerContextTools({
      getAuthUseCases: () =>
        ({
          getCurrentSession,
          checkPermission: vi.fn(),
        }) as ExplicitAny,
      logger: mockLogger,
    });

    await expect(tools.withPublicContext(async () => 'ok')).resolves.toBe('ok');

    expect(getSession).toHaveBeenCalledOnce();
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'server_fn.request.finish',
        requestId: 'request-1',
      })
    );
  });

  it('preserves the Start auth session method context', async () => {
    const auth = {
      currentSession: {
        session: mockSession,
        user: mockUser,
      },
      async getSession() {
        return this.currentSession;
      },
    };
    const getCurrentSession = vi.fn();
    getGlobalStartContextMock.mockReturnValue({
      auth,
      requestId: 'request-1',
    } as never);
    const tools = createServerContextTools({
      getAuthUseCases: () =>
        ({
          getCurrentSession,
          checkPermission: vi.fn(),
        }) as ExplicitAny,
      logger: mockLogger,
    });

    await expect(
      tools.withPublicContext(async (ctx) => ctx.session)
    ).resolves.toEqual(mockSession);

    expect(getCurrentSession).not.toHaveBeenCalled();
  });

  it('treats null Start request context as absent', async () => {
    const getCurrentSession = vi.fn(async () =>
      Result.Ok({ type: 'auth_session_missing' as const })
    );
    getGlobalStartContextMock.mockReturnValue(null as never);
    const tools = createServerContextTools({
      getAuthUseCases: () =>
        ({
          getCurrentSession,
          checkPermission: vi.fn(),
        }) as ExplicitAny,
      logger: mockLogger,
    });

    await expect(
      tools.withPublicContext(async (ctx) => ctx.session)
    ).resolves.toBeNull();

    expect(getCurrentSession).toHaveBeenCalledOnce();
  });

  it('treats malformed Start context values as absent', async () => {
    const getCurrentSession = vi.fn(async () =>
      Result.Ok({
        type: 'auth_session_found' as const,
        session: {
          session: mockSession,
          user: mockUser,
        },
      })
    );
    getGlobalStartContextMock.mockReturnValue({
      auth: { getSession: 'not-callable' },
      requestId: '  ',
    } as never);
    const tools = createServerContextTools({
      getAuthUseCases: () =>
        ({
          getCurrentSession,
          checkPermission: vi.fn(),
        }) as ExplicitAny,
      logger: mockLogger,
    });

    await expect(tools.withPublicContext(async () => 'ok')).resolves.toBe('ok');

    expect(getCurrentSession).toHaveBeenCalledOnce();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'server_fn.request.finish',
        requestId: expect.stringMatching(/\S/),
      })
    );
  });

  it('fails closed for unexpected permission outcomes', async () => {
    const checkPermission = vi.fn(async () =>
      Result.Ok({ type: 'auth_permission_unknown' as const })
    );
    const tools = createServerContextTools({
      getAuthUseCases: () =>
        ({
          getCurrentSession: vi.fn(),
          checkPermission,
        }) as ExplicitAny,
    });

    await expect(
      tools.assertPermission(unwrapParseResult(toUserId('user-1')), {
        design: ['read'],
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('maps auth context construction errors through the central handler', async () => {
    const error = new Error('auth unavailable');
    mockGetSession.mockRejectedValueOnce(error);

    await expect(withPublicContext(async () => 'ok')).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'server_fn.error.unhandled',
        exception: expect.objectContaining({
          cause: error,
          code: 'AUTH_SESSION_GATEWAY_ERROR',
        }),
      })
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
        }),
        event: 'server_fn.error.mapped',
      })
    );
  });

  it('logs expected transport errors at warning level', async () => {
    await expect(
      withPublicContext(async () => {
        throw new ServerFnError('CONFLICT', {
          message: 'Unique constraint violation',
          data: { target: ['email'] },
        });
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      data: { target: ['email'] },
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          code: 'CONFLICT',
          data: { target: ['email'] },
        }),
        event: 'server_fn.error.mapped',
      })
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe('withFreshProtectedMutation (step-up re-authentication)', () => {
  const NOW = Date.parse('2026-06-27T12:00:00.000Z');

  const makeFreshTools = (
    createdAt: Date | string | undefined,
    opts: { freshAgeSeconds?: number; now?: number } = {}
  ) => {
    const getCurrentSession = vi.fn(async () =>
      Result.Ok({
        type: 'auth_session_found' as const,
        session: {
          user: mockUser,
          session: { ...mockSession, createdAt },
        },
      })
    );
    return createServerContextTools({
      getAuthUseCases: () =>
        ({
          getCurrentSession,
          checkPermission: vi.fn(),
        }) as ExplicitAny,
      logger: mockLogger,
      getSessionFreshAgeSeconds: () => opts.freshAgeSeconds ?? 900,
      now: () => opts.now ?? NOW,
    });
  };

  it('passes through when the session is fresh', async () => {
    const tools = makeFreshTools(new Date(NOW - 5 * 60 * 1000)); // 5 min ago

    await expect(
      tools.withFreshProtectedMutation(async () => 'ok')
    ).resolves.toBe('ok');
  });

  it('parses provider ISO session timestamps at the transport boundary', async () => {
    const tools = makeFreshTools(new Date(NOW - 5 * 60 * 1000).toISOString());

    await expect(
      tools.withFreshProtectedMutation(async () => 'ok')
    ).resolves.toBe('ok');
  });

  it('rejects a stale session with FORBIDDEN + reauth_required', async () => {
    const tools = makeFreshTools(new Date(NOW - 60 * 60 * 1000)); // 60 min ago

    await expect(
      tools.withFreshProtectedMutation(async () => 'ok')
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { reason: 'reauth_required' },
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'security.reauth_required' })
    );
  });

  it('fails closed (reauth_required) when createdAt is missing', async () => {
    const tools = makeFreshTools(undefined);

    await expect(
      tools.withFreshProtectedMutation(async () => 'ok')
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { reason: 'reauth_required' },
    });
  });

  it('fails closed (reauth_required) when createdAt is unparseable', async () => {
    const tools = makeFreshTools('not-a-date');

    await expect(
      tools.withFreshProtectedMutation(async () => 'ok')
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { reason: 'reauth_required' },
    });
  });
});
