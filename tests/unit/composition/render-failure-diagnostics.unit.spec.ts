import { expect, it, vi } from 'vitest';

const database = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('database unavailable');
  })
);
const logger = vi.hoisted(() => {
  const warn = vi.fn();
  return { warn, create: vi.fn(() => ({ warn })) };
});
vi.mock('@/modules/kernel/backend', async (original) => ({
  ...(await original<typeof import('@/modules/kernel/backend')>()),
  createTelemetryLogger: logger.create,
}));
vi.mock('@/modules/kernel/infrastructure/db/client', async (original) => ({
  ...(await original<
    typeof import('@/modules/kernel/infrastructure/db/client')
  >()),
  getDefaultDbClient: database,
}));
vi.mock('@/composition/rendering-pipeline', () => {
  throw new Error('rendering unavailable');
});

import { reportFailurePersistenceException } from '@/composition/render-failure-diagnostics';

it('reports an intermediate warning without initializing the database or rendering pipeline', () => {
  const details = {
    resultId: 'result-1',
    attempt: 1,
    workflowRunId: 'workflow-1',
    receiptCapture: 'confirmed' as const,
    reason: 'PROVIDER_UNAVAILABLE',
    code: 'DB_UNAVAILABLE',
    errorNames: ['Error'],
    errorCodes: [],
  };
  reportFailurePersistenceException(details);
  reportFailurePersistenceException(details);
  expect(logger.create).toHaveBeenCalledOnce();
  expect(logger.warn).toHaveBeenCalledTimes(2);
  expect(logger.warn).toHaveBeenCalledWith({
    event: 'rendering.result.failure_persistence_exception',
    details,
  });
  expect(database).not.toHaveBeenCalled();
});
