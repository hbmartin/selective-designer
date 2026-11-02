import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServerEntry: vi.fn((entry: unknown) => entry),
  handlerFetch: vi.fn(async () => new Response('ok')),
  validateServerConfig: vi.fn(),
  wrapFetchWithSentry: vi.fn((entry: unknown) => entry),
}));

vi.mock('@sentry/tanstackstart-react', () => ({
  wrapFetchWithSentry: mocks.wrapFetchWithSentry,
}));

vi.mock('@tanstack/react-start/server-entry', () => ({
  default: {
    fetch: mocks.handlerFetch,
  },
  createServerEntry: mocks.createServerEntry,
}));

vi.mock('@/modules/kernel/backend', () => ({
  validateServerConfig: mocks.validateServerConfig,
}));

describe('server entry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('passes a request id through Start request context', async () => {
    const server = (await import('@/server')).default as {
      fetch: (request: Request) => Promise<Response>;
    };
    const request = new Request('https://app.example/');

    await server.fetch(request);

    expect(mocks.handlerFetch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        context: {
          requestId: expect.any(String),
        },
      })
    );
  });

  it('runs fail-closed config validation at boot (H1 regression)', async () => {
    await import('@/server');

    expect(mocks.validateServerConfig).toHaveBeenCalledTimes(1);
  });
});
