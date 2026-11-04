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
