import { afterEach, expect, it, vi } from 'vitest';

import { ObjectCopySourceError } from '@/modules/kernel/application/ports/object-storage';
import { BetterUploadObjectStorage } from '@/modules/kernel/backend';

const config = vi.hoisted(() => vi.fn());
vi.mock('@/modules/kernel/infrastructure/config/storage', () => ({
  getStorageConfig: config,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  config.mockReset();
});

it('returns a storage error when deletion cannot initialize the client', async () => {
  config.mockImplementation(() => {
    throw new Error('Storage configuration is unavailable.');
  });
  const result = await new BetterUploadObjectStorage().deleteObject(
    'region-masks/unpublished.png'
  );
  expect(result.isError() && result.getError().code).toBe(
    'OBJECT_STORAGE_DELETE_FAILED'
  );
});

it.each([
  { status: 404, deleted: true },
  { status: 403, deleted: false },
])(
  'discards a $status S3 response body without changing the outcome',
  async ({ status, deleted }) => {
    config.mockReturnValue({
      host: 'storage.example.test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      region: 'us-east-1',
      forcePathStyle: true,
      secure: true,
      bucketName: 'test-bucket',
    });
    const cancel = vi.fn().mockRejectedValue(new Error('already closed'));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(new ReadableStream({ cancel }), { status })
        )
    );
    const outcome = await new BetterUploadObjectStorage().deleteObject(
      'region-masks/new.png'
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(outcome.isOk()).toBe(deleted);
    expect(outcome.isError() && outcome.getError().message).toBe(
      deleted ? false : 'Object storage delete failed with status 403'
    );
  }
);

const storageConfig = () =>
  config.mockReturnValue({
    host: 'storage.example.test',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    region: 'us-east-1',
    forcePathStyle: true,
    secure: true,
    bucketName: 'test-bucket',
  });

it.each([
  { status: 201, type: 'object_created' },
  { status: 412, type: 'object_already_exists' },
  { status: 403, type: 'error' },
])(
  'uses create-only PUT and releases a $status response',
  async ({ status, type }) => {
    storageConfig();
    const cancel = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(new ReadableStream({ cancel }), { status })
      );
    vi.stubGlobal('fetch', fetch);
    const result = await new BetterUploadObjectStorage().createObject({
      objectKey: 'region-masks/collision.png',
      body: Uint8Array.of(1, 2),
      contentType: 'image/png',
      cacheControl: 'private, immutable',
    });
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request.method).toBe('PUT');
    expect(request.headers.get('if-none-match')).toBe('*');
    expect(request.headers.get('cache-control')).toBe('private, immutable');
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2)
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.isOk() ? result.get().type : 'error').toBe(type);
  }
);

it('preserves bytes when two creates compete for a key', async () => {
  storageConfig();
  let bytes: Uint8Array | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      const incoming = new Uint8Array(await request.arrayBuffer());
      if (bytes) return new Response(null, { status: 412 });
      bytes = incoming;
      return new Response(null, { status: 201 });
    })
  );
  const storage = new BetterUploadObjectStorage();
  const results = await Promise.all(
    [1, 2].map((byte) =>
      storage.createObject({
        objectKey: 'region-masks/shared.png',
        body: Uint8Array.of(byte),
        contentType: 'image/png',
      })
    )
  );
  expect(
    results.map((result) => result.isOk() && result.get().type).sort()
  ).toEqual(['object_already_exists', 'object_created']);
  const winner = results.findIndex(
    (result) => result.isOk() && result.get().type === 'object_created'
  );
  expect(bytes).toEqual(Uint8Array.of(winner + 1));
});

it.each(['network', 'timeout'] as const)(
  'reports a %s source failure without attempting PUT',
  async (reason) => {
    storageConfig();
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockRejectedValue(
        reason === 'timeout'
          ? new DOMException('timed out', 'AbortError')
          : new Error('connection reset')
      );
    vi.stubGlobal('fetch', fetch);
    const pending = new BetterUploadObjectStorage().copyNewObjectFromUrl({
      sourceUrl: 'https://provider.test/mask.png',
      objectKey: 'region-masks/fresh.png',
      acceptedContentTypes: ['image/png'],
      maxBytes: 100,
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError() && result.getError()).toBeInstanceOf(
      ObjectCopySourceError
    );
    expect(result.isError() && result.getError()).toMatchObject({
      reason,
      attempts: 3,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  }
);

const copyInput = {
  sourceUrl: 'https://provider.test/mask.png?token=private',
  objectKey: 'region-masks/fresh.png',
  acceptedContentTypes: ['image/png'],
  maxBytes: 100,
};

it.each([408, 429, 500, 503])(
  'retries source HTTP %s on the same URL and disposes its body',
  async (status) => {
    storageConfig();
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), { status })
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.of(1, 2), {
          headers: { 'content-type': 'image/png' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const pending = new BetterUploadObjectStorage().copyNewObjectFromUrl(
      copyInput
    );
    await vi.runAllTimersAsync();
    expect((await pending).isOk()).toBe(true);
    expect(fetch.mock.calls.slice(0, 2).map(([url]) => String(url))).toEqual([
      copyInput.sourceUrl,
      copyInput.sourceUrl,
    ]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  }
);

it('bounds repeated timeouts to the total source budget without attempting a PUT', async () => {
  storageConfig();
  vi.useFakeTimers();
  const fetch = vi.fn(
    (_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener(
          'abort',
          () => reject(new DOMException('timeout', 'AbortError')),
          { once: true }
        );
      })
  );
  vi.stubGlobal('fetch', fetch);
  const started = performance.now();
  const pending = new BetterUploadObjectStorage().copyNewObjectFromUrl(
    copyInput
  );
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.isError() && result.getError()).toMatchObject({
    reason: 'timeout',
    attempts: 3,
  });
  expect(performance.now() - started).toBe(60_000);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves the original nested network diagnostic after exhaustion', async () => {
  storageConfig();
  vi.useFakeTimers();
  const cause = new TypeError('fetch failed', {
    cause: Object.assign(new Error('TLS handshake failed'), {
      code: 'CERT_HAS_EXPIRED',
    }),
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
  const pending = new BetterUploadObjectStorage().copyFromUrl(copyInput);
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.isError() && result.getError().cause).toBe(cause);
});

it.each(['fake', 'adapter'] as const)(
  'honors the create-only copy contract in the %s',
  async (kind) => {
    const { createFakeObjectStorage } =
      await import('@tests/support/fake-kernel-ports');
    const memory = createFakeObjectStorage();
    storageConfig();
    const objects = memory.objects;
    const sources = new Map([
      [
        copyInput.sourceUrl,
        { bytes: Uint8Array.of(1, 2), contentType: 'image/png' },
      ],
    ]);
    memory.addRemoteSource(
      copyInput.sourceUrl,
      sources.get(copyInput.sourceUrl)!
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: URL | Request) => {
        if (request instanceof Request) {
          expect(request.headers.get('if-none-match')).toBe('*');
          const bytes = new Uint8Array(await request.arrayBuffer());
          const key = new URL(request.url).pathname
            .split('/')
            .slice(2)
            .join('/');
          if (objects.has(key)) return new Response(null, { status: 412 });
          objects.set(key, { bytes, contentType: 'image/png' });
          return new Response(null, { status: 201 });
        }
        const source = sources.get(String(request));
        return source
          ? new Response(new Uint8Array(source.bytes), {
              headers: { 'content-type': source.contentType },
            })
          : new Response(null, { status: 404 });
      })
    );
    const storage =
      kind === 'fake' ? memory.storage : new BetterUploadObjectStorage();
    const results = await Promise.all([
      storage.copyNewObjectFromUrl(copyInput),
      storage.copyNewObjectFromUrl(copyInput),
    ]);
    expect(
      results.map((result) => result.isOk() && result.get().type).sort()
    ).toEqual(['object_already_exists', 'object_created']);
    expect(objects.get(copyInput.objectKey)?.bytes).toEqual(
      Uint8Array.of(1, 2)
    );
    const unavailable = await storage.copyNewObjectFromUrl({
      ...copyInput,
      sourceUrl: 'https://provider.test/missing',
    });
    expect(unavailable.isOk() && unavailable.get()).toEqual({
      type: 'copy_source_unavailable',
      status: 404,
    });
    const invalid = await storage.copyNewObjectFromUrl({
      ...copyInput,
      sourceUrl: 'http://provider.test/mask',
    });
    expect(invalid.isOk() && invalid.get()).toEqual({
      type: 'copy_source_rejected',
      reason: 'insecure_url',
    });
  }
);

it.each(['ENOTFOUND', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])(
  'fails fast without a destination write for permanent source code %s',
  async (code) => {
    storageConfig();
    vi.useFakeTimers();
    const cause = new TypeError('fetch failed', {
      cause: Object.assign(new Error('private URL omitted'), { code }),
    });
    const fetch = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal('fetch', fetch);
    const result = await new BetterUploadObjectStorage().copyNewObjectFromUrl(
      copyInput
    );
    expect(result.isError() && result.getError()).toMatchObject({
      retryable: false,
      attempts: 1,
      cause,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  }
);

it('retries a temporary DNS error on the same source', async () => {
  storageConfig();
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: { code: 'EAI_AGAIN' } })
    )
    .mockResolvedValueOnce(
      new Response(Uint8Array.of(1), {
        headers: { 'content-type': 'image/png' },
      })
    )
    .mockResolvedValueOnce(new Response(null, { status: 201 }));
  vi.stubGlobal('fetch', fetch);
  const pending = new BetterUploadObjectStorage().copyNewObjectFromUrl(
    copyInput
  );
  await vi.runAllTimersAsync();
  expect((await pending).isOk()).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(['7', new Date(Date.now() + 7_000).toUTCString()])(
  'honors Retry-After %s before reading the source again',
  async (retryAfter) => {
    storageConfig();
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'retry-after': retryAfter },
        })
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.of(1), {
          headers: { 'content-type': 'image/png' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const pending = new BetterUploadObjectStorage().copyNewObjectFromUrl(
      copyInput
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect((await pending).isOk()).toBe(true);
  }
);

it('defers Retry-After beyond the total budget without another source read', async () => {
  storageConfig();
  vi.useFakeTimers();
  const cancel = vi.fn();
  const fetch = vi.fn().mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      status: 503,
      headers: { 'retry-after': '120' },
    })
  );
  vi.stubGlobal('fetch', fetch);
  const pending = new BetterUploadObjectStorage().copyNewObjectFromUrl(
    copyInput
  );
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.isError() && result.getError()).toMatchObject({
    retryAfterMs: 120_000,
    retryable: true,
    sourceStatus: 503,
    attempts: 1,
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
