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

const loadReporters = () => import('@/composition/render-failure-diagnostics');

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

it('reports both intermediate warnings without initializing the database or rendering pipeline', async () => {
  const { reportFailurePersistenceException, reportSubmissionException } =
    await loadReporters();
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
  async () =>
    (await loadReporters()).reportFailurePersistenceException(failure),
  async () => (await loadReporters()).reportSubmissionException(submission),
])(
  'keeps a warning best effort when the logger throws (%#)',
  async (report) => {
    mockLogger.warn.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });
    await expect(report()).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledOnce();
  }
);

it('reports a subsequent warning after an unexpected logger construction error', async () => {
  vi.resetModules();
  const logger =
    await import('@/modules/kernel/infrastructure/logger/telemetry');
  const createLogger = vi
    .spyOn(logger, 'createTelemetryLogger')
    .mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });
  try {
    const { reportFailurePersistenceException, reportSubmissionException } =
      await loadReporters();
    expect(() => reportFailurePersistenceException(failure)).not.toThrow();
    expect(mockLogger.warn).not.toHaveBeenCalled();

    reportSubmissionException(submission);
    expect(mockLogger.warn).toHaveBeenCalledExactlyOnceWith({
      event: 'rendering.result.submission_persistence_exception',
      details: submission,
    });
  } finally {
    createLogger.mockRestore();
  }
});
