import { expect, it, vi } from 'vitest';

const database = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('database unavailable');
  })
);
vi.mock('@/modules/kernel/infrastructure/db/client', async (original) => ({
  ...(await original<
    typeof import('@/modules/kernel/infrastructure/db/client')
  >()),
  getDefaultDbClient: database,
}));
vi.mock('@/composition/rendering-pipeline', () => {
  throw new Error('rendering unavailable');
});

import { getRenderFailureLogger } from '@/composition/render-failure-diagnostics';

it('caches a logger without initializing the database or rendering pipeline', () => {
  const logger = getRenderFailureLogger();
  expect(logger.warn).toBeTypeOf('function');
  expect(getRenderFailureLogger()).toBe(logger);
  expect(database).not.toHaveBeenCalled();
});
