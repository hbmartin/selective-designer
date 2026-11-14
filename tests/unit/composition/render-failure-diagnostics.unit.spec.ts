import { mockLogger } from '@tests/server/test-utils';
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

import {
  reportFailurePersistenceException,
  reportSubmissionException,
} from '@/composition/render-failure-diagnostics';

const details = {
  resultId: 'result-1',
  attempt: 1,
  workflowRunId: 'workflow-1',
  code: 'DB_UNAVAILABLE',
  errorNames: ['Error'],
  errorCodes: [],
};
const failure = {
  ...details,
  receiptCapture: 'confirmed' as const,
  reason: 'PROVIDER_UNAVAILABLE',
};
const submission = { ...details, lastKnownCode: 'WRITE_UNCONFIRMED' };

it('reports both intermediate warnings without initializing the database or rendering pipeline', () => {
  reportFailurePersistenceException(failure);
  reportSubmissionException(submission);
  expect(mockLogger.warn.mock.calls).toEqual([
    [
      {
        event: 'rendering.result.failure_persistence_exception',
        details: failure,
      },
    ],
    [
      {
        event: 'rendering.result.submission_persistence_exception',
        details: submission,
      },
    ],
  ]);
  expect(database).not.toHaveBeenCalled();
});

it.each([
  () => reportFailurePersistenceException(failure),
  () => reportSubmissionException(submission),
])('keeps a warning best effort when the logger throws (%#)', (report) => {
  mockLogger.warn.mockImplementationOnce(() => {
    throw new Error('logger unavailable');
  });
  expect(report).not.toThrow();
  expect(mockLogger.warn).toHaveBeenCalledOnce();
});
