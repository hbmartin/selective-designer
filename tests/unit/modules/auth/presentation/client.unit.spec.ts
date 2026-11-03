import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  betterAuthBrowserClient: {
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  },
  fetch: vi.fn(),
  useCurrentSessionQuery: vi.fn(),
  useMatches: vi.fn(),
}));

vi.mock('@/modules/auth/presentation/better-auth-client', () => ({
  authErrorCodes: {},
  betterAuthBrowserClient: mocks.betterAuthBrowserClient,
}));

vi.mock('@tanstack/react-router', () => ({
  useMatches: mocks.useMatches,
}));

import {
  createUseAuthSession,
  signOut,
  startSignIn,
} from '@/modules/auth/presentation/client';

describe('auth client facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.useMatches.mockReturnValue(undefined);
  });

  it('submits the credentials without exposing the provider session', async () => {
    const credentials = {
      email: 'user@example.com',
      password: 'test-password',
    };
    mocks.betterAuthBrowserClient.signInWithPassword.mockResolvedValue({
      data: { token: 'provider-token' },
      error: null,
    });
    await expect(startSignIn(credentials)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      mocks.betterAuthBrowserClient.signInWithPassword
    ).toHaveBeenCalledWith(credentials);
  });

  it('maps rejected credentials into a neutral error result', async () => {
    mocks.betterAuthBrowserClient.signInWithPassword.mockResolvedValue({
      error: { code: 'INVALID_EMAIL_OR_PASSWORD' },
    });
    await expect(
      startSignIn({ email: 'user@example.com', password: 'wrong-password' })
    ).resolves.toEqual({
      ok: false,
      code: 'INVALID_EMAIL_OR_PASSWORD',
    });
  });

  it('signs out through a neutral result contract', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(signOut()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(mocks.fetch).toHaveBeenCalledWith('/logout', {
      credentials: 'same-origin',
      method: 'POST',
    });
    expect(mocks.betterAuthBrowserClient.signOut).not.toHaveBeenCalled();
  });

  it('maps logout HTTP failures into a neutral error result', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(null, {
        status: 500,
        statusText: 'Internal Server Error',
      })
    );

    await expect(signOut()).resolves.toEqual({
      ok: false,
      code: 'SIGN_OUT_FAILED',
      message: 'Internal Server Error',
    });
    expect(mocks.fetch).toHaveBeenCalledWith('/logout', {
      credentials: 'same-origin',
      method: 'POST',
    });
    expect(mocks.betterAuthBrowserClient.signOut).not.toHaveBeenCalled();
  });

  it('includes the HTTP status when logout failure status text is empty', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 502 }));

    await expect(signOut()).resolves.toEqual({
      ok: false,
      code: 'SIGN_OUT_FAILED',
      message: 'HTTP error 502',
    });
  });

  it('uses the sanitized current-session query for session reads', () => {
    const query = { data: null, isPending: false };
    const useAuthSession = createUseAuthSession(mocks.useCurrentSessionQuery);
    mocks.useCurrentSessionQuery.mockReturnValue(query);

    expect(useAuthSession()).toBe(query);
    expect(mocks.useCurrentSessionQuery).toHaveBeenCalledWith(undefined);
  });

  it('seeds session reads from protected route context during hydration', () => {
    const routeSession = { user: { id: 'user-1' } };
    const query = { data: routeSession, isPending: false };
    const useAuthSession = createUseAuthSession(mocks.useCurrentSessionQuery);
    mocks.useMatches.mockReturnValue(routeSession);
    mocks.useCurrentSessionQuery.mockReturnValue(query);

    expect(useAuthSession()).toBe(query);
    expect(mocks.useCurrentSessionQuery).toHaveBeenCalledWith(routeSession);
  });
});
