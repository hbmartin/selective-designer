import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/modules/kernel/infrastructure/logger/telemetry');

const mocks = vi.hoisted(() => ({
  createServerEntry: vi.fn((entry: unknown) => entry),
  handlerFetch: vi.fn(async () => new Response('ok')),
  delivery: vi.fn(),
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

vi.mock('@/composition/telemetry/sentry.server', () => ({
  getServerTelemetry: () => ({ destinations: [mocks.delivery] }),
  initTelemetryServer: () => undefined,
  withServerTelemetryScope: (run: () => unknown) => run(),
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

  it('returns the failed upload response while the host retains its pending diagnostic', async () => {
    const sink = Promise.withResolvers<boolean>();
    const started = Promise.withResolvers<void>();
    mocks.delivery.mockImplementationOnce(() => {
      started.resolve();
      return sink.promise;
    });
    const { deferTerminalDiagnostic } =
      await import('@/composition/telemetry/terminal-diagnostic');
    mocks.handlerFetch.mockImplementationOnce(async () => {
      deferTerminalDiagnostic({
        event: 'image.write.unresolved',
        details: { imageId: 'upload', errorNames: [], errorCodes: [] },
      });
      return new Response(null, { status: 500 });
    });
    const server = (await import('@/server')).default;
    const waitUntil = vi.fn<(task: Promise<void>) => void>();
    const request = Object.assign(new Request('https://app.example/'), {
      waitUntil,
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      const response = await server.fetch(request, {
        context: { requestId: 'test' },
      });
      expect(response.status).toBe(500);
      expect(waitUntil).toHaveBeenCalledOnce();
      await started.promise;
      expect(mocks.delivery).toHaveBeenCalledOnce();
    } finally {
      sink.resolve(true);
      await waitUntil.mock.calls[0]?.[0];
      consoleError.mockRestore();
    }
  });

  it.each([
    undefined,
    () => {
      throw new Error('registration unavailable');
    },
  ])(
    'uses one console diagnostic when the host cannot retain the upload diagnostic',
    async (waitUntil) => {
      const { deferTerminalDiagnostic } =
        await import('@/composition/telemetry/terminal-diagnostic');
      mocks.handlerFetch.mockImplementationOnce(async () => {
        deferTerminalDiagnostic({
          event: 'image.write.unresolved',
          details: { imageId: 'upload', errorNames: [], errorCodes: [] },
        });
        return new Response(null, { status: 500 });
      });
      const server = (await import('@/server')).default;
      const request = Object.assign(new Request('https://app.example/'), {
        waitUntil,
      });
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      try {
        expect(
          (await server.fetch(request, { context: { requestId: 'test' } }))
            .status
        ).toBe(500);
        expect(consoleError).toHaveBeenCalledOnce();
        expect(mocks.delivery).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    }
  );
});
