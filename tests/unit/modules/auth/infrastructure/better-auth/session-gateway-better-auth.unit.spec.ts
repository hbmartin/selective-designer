import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Auth } from '@/modules/auth/infrastructure/better-auth/auth';
import type { Database } from '@/modules/kernel/infrastructure/db/client';
import type { TelemetryAdapter } from '@/platform/telemetry';

vi.mock('@/modules/auth/infrastructure/better-auth/auth', () => ({
  getDefaultAuth: vi.fn(),
}));

const startSpan = vi.fn((_options: unknown, fn: () => unknown) => fn());
const telemetry = { startSpan } as unknown as Pick<
  TelemetryAdapter,
  'startSpan'
>;

const SESSION_ABSOLUTE_MAX_IN_SECONDS = 2_592_000;

vi.mock('@/modules/kernel/infrastructure/config/auth', () => ({
  getBetterAuthConfig: () => ({
    sessionAbsoluteMaxInSeconds: SESSION_ABSOLUTE_MAX_IN_SECONDS,
  }),
}));

const loadGateway = async () =>
  import('@/modules/auth/infrastructure/better-auth/session-gateway-better-auth');

const makeAuth = (
  role: unknown,
  overrides: {
    userId?: string;
    email?: string;
    createdAt?: Date | string | null;
  } = {}
): Auth =>
  ({
    api: {
      getSession: vi.fn(async () => ({
        user: {
          id: overrides.userId ?? 'user-1',
          email: overrides.email ?? 'user@example.com',
          name: 'Test User',
          image: null,
          emailVerified: true,
          role,
          onboardedAt: null,
        },
        session: {
          id: 'session-1',
          userId: overrides.userId ?? 'user-1',
          createdAt:
            'createdAt' in overrides ? overrides.createdAt : new Date(),
          expiresAt: new Date('2026-12-31'),
        },
      })),
    },
  }) as unknown as Auth;

const makeDb = (
  input: {
    identityUserId?: string;
    appUser?: {
      id: string;
      email: string;
      name: string;
      image: string | null;
      emailVerified: boolean;
      role: string;
      onboardedAt: Date | null;
    } | null;
  } = {}
) => {
  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  return {
    query: {
      authIdentity: {
        findFirst: vi.fn(async () =>
          input.identityUserId ? { userId: input.identityUserId } : null
        ),
      },
      user: {
        findFirst: vi.fn(async () => input.appUser ?? null),
      },
    },
    insert,
    __insertValues: values,
    __onConflictDoNothing: onConflictDoNothing,
  } as unknown as Database & {
    __insertValues: typeof values;
    __onConflictDoNothing: typeof onConflictDoNothing;
  };
};

describe('SessionGatewayBetterAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps valid provider roles', async () => {
    const { SessionGatewayBetterAuth } = await loadGateway();
    const db = makeDb();
    const gateway = new SessionGatewayBetterAuth(
      makeAuth('admin'),
      db,
      undefined,
      telemetry
    );

    const session = await gateway.getSession({ headers: new Headers() });

    expect(session.isOk()).toBe(true);
    expect(session).toMatchObject({
      tag: 'Ok',
      value: {
        type: 'auth_session_found',
        session: { user: { role: 'admin' } },
      },
    });
    expect(db.__insertValues).toHaveBeenCalledWith({
      provider: 'better-auth',
      providerUserId: 'user-1',
      userId: 'user-1',
    });
    expect(startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'auth.provider': 'better-auth',
          'operation.name': 'auth.getSession',
        }),
        name: 'auth.getSession',
        op: 'auth.provider',
      }),
      expect.any(Function)
    );
  });

  it('falls back to the least-privileged role for unknown provider roles', async () => {
    const { SessionGatewayBetterAuth } = await loadGateway();
    const gateway = new SessionGatewayBetterAuth(
      makeAuth('owner'),
      makeDb(),
      undefined,
      telemetry
    );

    const session = await gateway.getSession({ headers: new Headers() });

    expect(session.isOk()).toBe(true);
    expect(session).toMatchObject({
      tag: 'Ok',
      value: {
        type: 'auth_session_found',
        session: { user: { role: 'user' } },
      },
    });
  });

  it('maps provider users to local app users through auth identity', async () => {
    const { SessionGatewayBetterAuth } = await loadGateway();
    const gateway = new SessionGatewayBetterAuth(
      makeAuth('user', {
        userId: 'provider-user-1',
        email: 'provider@example.com',
      }),
      makeDb({
        identityUserId: 'app-user-1',
        appUser: {
          id: 'app-user-1',
          email: 'app@example.com',
          name: 'App User',
          image: null,
          emailVerified: true,
          role: 'admin',
          onboardedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      }),
      undefined,
      telemetry
    );

    const session = await gateway.getSession({ headers: new Headers() });

    expect(session.isOk()).toBe(true);
    expect(session).toMatchObject({
      tag: 'Ok',
      value: {
        type: 'auth_session_found',
        session: {
          user: {
            id: 'app-user-1',
            email: 'app@example.com',
            role: 'admin',
          },
          session: {
            id: 'session-1',
            userId: 'app-user-1',
          },
        },
      },
    });
  });

  it('treats orphaned auth identities as unauthenticated', async () => {
    const { SessionGatewayBetterAuth } = await loadGateway();
    const gateway = new SessionGatewayBetterAuth(
      makeAuth('user', {
        userId: 'provider-user-1',
        email: 'provider@example.com',
      }),
      makeDb({
        identityUserId: 'deleted-app-user',
        appUser: null,
      }),
      undefined,
      telemetry
    );

    const session = await gateway.getSession({ headers: new Headers() });

    expect(session.isOk()).toBe(true);
    expect(session).toMatchObject({
      tag: 'Ok',
      value: { type: 'auth_session_missing' },
    });
  });

  it('carries the provider session createdAt for the freshness policy', async () => {
    const { SessionGatewayBetterAuth } = await loadGateway();
    const createdAt = new Date('2026-06-10T09:00:00.000Z');
    const clock = { now: () => new Date('2026-06-10T09:05:00.000Z') };
    const gateway = new SessionGatewayBetterAuth(
      makeAuth('admin', { createdAt }),
      makeDb(),
      clock,
      telemetry
    );

    const session = await gateway.getSession({ headers: new Headers() });

    expect(session).toMatchObject({
      tag: 'Ok',
      value: {
        type: 'auth_session_found',
        session: { session: { createdAt } },
      },
    });
  });

  it('keeps sessions still within the absolute max age', async () => {
    const { SessionGatewayBetterAuth } = await loadGateway();
    const createdAt = new Date('2026-06-01T00:00:00.000Z');
    const clock = { now: () => new Date('2026-06-10T00:00:00.000Z') };
    const gateway = new SessionGatewayBetterAuth(
      makeAuth('admin', { createdAt }),
      makeDb(),
      clock,
      telemetry
    );

    const session = await gateway.getSession({ headers: new Headers() });

    expect(session).toMatchObject({
      tag: 'Ok',
      value: { type: 'auth_session_found' },
    });
  });

  it('expires perpetually-refreshed sessions past the absolute max age', async () => {
    const { SessionGatewayBetterAuth } = await loadGateway();
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    // Well beyond the 30-day cap even though expiresAt is still in the future.
    const clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };
    const gateway = new SessionGatewayBetterAuth(
      makeAuth('admin', { createdAt }),
      makeDb(),
      clock,
      telemetry
    );

    const session = await gateway.getSession({ headers: new Headers() });

    expect(session).toMatchObject({
      tag: 'Ok',
      value: { type: 'auth_session_missing' },
    });
  });

  it.each([null, 'not-a-date'])(
    'treats invalid session createdAt as unauthenticated: %s',
    async (createdAt) => {
      const { SessionGatewayBetterAuth } = await loadGateway();
      const clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };
      const gateway = new SessionGatewayBetterAuth(
        makeAuth('admin', { createdAt }),
        makeDb(),
        clock,
        telemetry
      );

      const session = await gateway.getSession({ headers: new Headers() });

      expect(session).toMatchObject({
        tag: 'Ok',
        value: { type: 'auth_session_missing' },
      });
    }
  );
});
