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
          cspNonce: expect.any(String),
        },
      })
    );
  });

  it('rewrites the CSP nonce placeholder after Start returns the response', async () => {
    mocks.handlerFetch.mockImplementationOnce(
      async () =>
        new Response('<script nonce="__START_UI_CSP_NONCE__"></script>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
    );
    const server = (await import('@/server')).default as {
      fetch: (request: Request) => Promise<Response>;
    };

    const response = await server.fetch(new Request('https://app.example/'));
    const context = (
      mocks.handlerFetch.mock.calls[0] as unknown as [
        Request,
        { context: { cspNonce: string } },
      ]
    )[1].context;

    await expect(response.text()).resolves.toBe(
      `<script nonce="${context.cspNonce}"></script>`
    );
  });

  it('runs fail-closed config validation at boot (H1 regression)', async () => {
    await import('@/server');

    expect(mocks.validateServerConfig).toHaveBeenCalledTimes(1);
  });
});
