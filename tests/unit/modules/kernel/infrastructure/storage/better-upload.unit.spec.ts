import { afterEach, expect, it, vi } from 'vitest';

import { BetterUploadObjectStorage } from '@/modules/kernel/backend';

const config = vi.hoisted(() => vi.fn());
vi.mock('@/modules/kernel/infrastructure/config/storage', () => ({
  getStorageConfig: config,
}));

afterEach(() => {
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
    const fetch = vi
      .fn()
      .mockRejectedValue(
        reason === 'timeout'
          ? new DOMException('timed out', 'AbortError')
          : new Error('connection reset')
      );
    vi.stubGlobal('fetch', fetch);
    const result = await new BetterUploadObjectStorage().copyNewObjectFromUrl({
      sourceUrl: 'https://provider.test/mask.png',
      objectKey: 'region-masks/fresh.png',
      acceptedContentTypes: ['image/png'],
      maxBytes: 100,
    });
    expect(result.isOk() && result.get()).toEqual({
      type: 'copy_source_unavailable',
      reason,
    });
    expect(fetch).toHaveBeenCalledOnce();
  }
);
