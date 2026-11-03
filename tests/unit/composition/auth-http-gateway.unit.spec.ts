import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handler = vi.fn(async () => new Response('provider'));
  const testAuthSecret = ['test', 'auth', 'secret'].join('-');

  return {
    authConfig: {
      adminEndpointsEnabled: false,
      allowedHosts: undefined as string[] | undefined,
      openApiEnabled: false,
      secret: testAuthSecret,
      sessionExpirationInSeconds: 2_592_000,
      sessionUpdateAgeInSeconds: 86_400,
      trustedOrigins: undefined as string[] | undefined,
    },
    createAuth: vi.fn(() => ({ handler })),
    handler,
  };
});

vi.mock('@/modules/kernel/infrastructure/config/auth', () => ({
  getAuthProviderConfig: () => ({ provider: 'better-auth' }),
  getBetterAuthConfig: () => mocks.authConfig,
}));

vi.mock('@/modules/kernel/backend', () => ({
  createTelemetryLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
  getAuthProviderConfig: () => ({ provider: 'better-auth' }),
  getBetterAuthConfig: () => mocks.authConfig,
  getRedisConfig: () => undefined,
}));

vi.mock('@/modules/auth/infrastructure/better-auth/auth', () => ({
  createAuth: mocks.createAuth,
}));

describe('auth HTTP gateway exposure policy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.authConfig.adminEndpointsEnabled = false;
    mocks.authConfig.openApiEnabled = false;
    mocks.handler.mockResolvedValue(new Response('provider'));
  });

  it('returns 404 for admin HTTP endpoints when admin endpoints are disabled', async () => {
    mocks.authConfig.adminEndpointsEnabled = false;
    const { getAuthHttpGateway } = await import('@/composition/auth');

    const gateway = getAuthHttpGateway();
    const response = await gateway.handle(
      new Request('http://localhost/api/auth/admin/remove-user', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('forwards core auth endpoints to the provider handler', async () => {
    mocks.authConfig.adminEndpointsEnabled = true;
    const { getAuthHttpGateway } = await import('@/composition/auth');

    const gateway = getAuthHttpGateway();
    const response = await gateway.handle(
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
      })
    );

    await expect(response.text()).resolves.toBe('provider');
    expect(mocks.handler).toHaveBeenCalledOnce();
  });
});
