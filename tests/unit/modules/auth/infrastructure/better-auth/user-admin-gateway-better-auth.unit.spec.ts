import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Auth } from '@/modules/auth/infrastructure/better-auth/auth';
import { UserAdminGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/user-admin-gateway-better-auth';
import { toSessionId, toUserId } from '@/modules/kernel/domain/ids';
import type { Database } from '@/modules/kernel/infrastructure/db/client';
import { unwrapParseResult } from '@/modules/kernel/testing';
import type { TelemetryAdapter } from '@/platform/telemetry';

const startSpan = vi.fn((_options: unknown, fn: () => unknown) => fn());
const telemetry = { startSpan } as unknown as Pick<
  TelemetryAdapter,
  'startSpan'
>;

const makeAuth = () => ({
  api: {
    revokeUserSession: vi.fn(async () => ({ success: true })),
  },
});

const makeDb = (input: {
  session: { token: string; userId: string } | null;
  identityUserId?: string;
}) =>
  ({
    query: {
      session: {
        findFirst: vi.fn(async () => input.session),
      },
      authIdentity: {
        findFirst: vi.fn(async () =>
          input.identityUserId ? { userId: input.identityUserId } : null
        ),
      },
    },
  }) as unknown as Database;

describe('UserAdminGatewayBetterAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the provider session token inside the adapter', async () => {
    const auth = makeAuth();
    const gateway = new UserAdminGatewayBetterAuth(
      auth as unknown as Auth,
      makeDb({ session: { token: 'session-token', userId: 'user-1' } }),
      telemetry
    );
    const headers = new Headers();

    const result = await gateway.revokeUserSession({
      userId: unwrapParseResult(toUserId('user-1')),
      sessionId: unwrapParseResult(toSessionId('session-1')),
      headers,
    });

    expect(result.isOk()).toBe(true);
    expect(result).toMatchObject({
      tag: 'Ok',
      value: { type: 'auth_user_session_revoked' },
    });

    expect(auth.api.revokeUserSession).toHaveBeenCalledWith({
      body: { sessionToken: 'session-token' },
      headers,
    });
    expect(startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'auth.provider': 'better-auth',
          'operation.name': 'auth.revokeUserSession',
        }),
        name: 'auth.revokeUserSession',
        op: 'auth.provider',
      }),
      expect.any(Function)
    );
  });

  it('revokes a provider session mapped to the requested app user', async () => {
    const auth = makeAuth();
    const gateway = new UserAdminGatewayBetterAuth(
      auth as unknown as Auth,
      makeDb({
        session: { token: 'session-token', userId: 'provider-user-1' },
        identityUserId: 'app-user-1',
      }),
      telemetry
    );

    const result = await gateway.revokeUserSession({
      userId: unwrapParseResult(toUserId('app-user-1')),
      sessionId: unwrapParseResult(toSessionId('session-1')),
      headers: new Headers(),
    });

    expect(result.isOk()).toBe(true);
    expect(result).toMatchObject({
      tag: 'Ok',
      value: { type: 'auth_user_session_revoked' },
    });

    expect(auth.api.revokeUserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { sessionToken: 'session-token' },
      })
    );
  });

  it('does not call Better Auth when the session does not belong to the user', async () => {
    const auth = makeAuth();
    const gateway = new UserAdminGatewayBetterAuth(
      auth as unknown as Auth,
      makeDb({
        session: { token: 'session-token', userId: 'provider-user-1' },
        identityUserId: 'other-app-user',
      }),
      telemetry
    );

    const result = await gateway.revokeUserSession({
      userId: unwrapParseResult(toUserId('user-1')),
      sessionId: unwrapParseResult(toSessionId('session-1')),
      headers: new Headers(),
    });

    expect(result.isError()).toBe(true);
    expect(result).toMatchObject({
      tag: 'Error',
      error: {
        category: 'forbidden',
        code: 'AUTH_USER_SESSION_OWNER_MISMATCH',
        status: 403,
      },
    });

    expect(auth.api.revokeUserSession).not.toHaveBeenCalled();
  });

  it('does not call Better Auth when the session is missing', async () => {
    const auth = makeAuth();
    const gateway = new UserAdminGatewayBetterAuth(
      auth as unknown as Auth,
      makeDb({ session: null }),
      telemetry
    );

    const result = await gateway.revokeUserSession({
      userId: unwrapParseResult(toUserId('user-1')),
      sessionId: unwrapParseResult(toSessionId('session-1')),
      headers: new Headers(),
    });

    expect(result.isError()).toBe(true);
    expect(result).toMatchObject({
      tag: 'Error',
      error: {
        category: 'not_found',
        code: 'AUTH_USER_SESSION_TOKEN_NOT_FOUND',
        status: 404,
      },
    });

    expect(auth.api.revokeUserSession).not.toHaveBeenCalled();
  });
});
