import { expect, it, vi } from 'vitest';

import { BetterUploadObjectStorage } from '@/modules/kernel/backend';

vi.mock('@/modules/kernel/infrastructure/config/storage', () => ({
  getStorageConfig: () => {
    throw new Error('Storage configuration is unavailable.');
  },
}));

it('returns a storage error when deletion cannot initialize the client', async () => {
  const result = await new BetterUploadObjectStorage().deleteObject(
    'region-masks/unpublished.png'
  );
  expect(result.isError() && result.getError().code).toBe(
    'OBJECT_STORAGE_DELETE_FAILED'
  );
});
