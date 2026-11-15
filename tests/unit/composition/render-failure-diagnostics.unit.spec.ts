import { mockLogger } from '@tests/server/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  database: vi.fn(() => {
    throw new Error('database unavailable');
  }),
  rendering: vi.fn(() => {
    throw new Error('rendering unavailable');
  }),
}));
vi.mock('@/modules/kernel/infrastructure/db/client', () =>
  dependencies.database()
);
vi.mock('@/composition/rendering-pipeline', () => dependencies.rendering());

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('LOGGER_LEVEL', 'info');
  vi.stubEnv('LOGGER_CONSOLE_MIRROR', 'false');
  vi.stubEnv('LOGGER_PRETTY', 'false');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const loadReporters = () => import('@/composition/render-failure-diagnostics');
const spyOnLoggerFactory = async () =>
  vi.spyOn(
    await import('@/modules/kernel/infrastructure/logger/telemetry'),
    'createTelemetryLogger'
  );

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

it('shares one logger for both intermediate warnings without initializing the database or rendering pipeline', async () => {
  const createLogger = await spyOnLoggerFactory();
  const { telemetryProxy } = await import('@/composition/telemetry');
  const { reportFailurePersistenceException, reportSubmissionException } =
    await loadReporters();
  expect(createLogger).not.toHaveBeenCalled();

  reportFailurePersistenceException(failure);
  reportSubmissionException(submission);
  await vi.dynamicImportSettled();

  expect(dependencies.database).not.toHaveBeenCalled();
  expect(dependencies.rendering).not.toHaveBeenCalled();
  expect(createLogger).toHaveBeenCalledExactlyOnceWith({
    telemetry: telemetryProxy,
  });
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
  const createLogger = await spyOnLoggerFactory();
  createLogger.mockImplementationOnce(() => {
    throw new Error('logger unavailable');
  });
  const { reportFailurePersistenceException, reportSubmissionException } =
    await loadReporters();
  expect(() => reportFailurePersistenceException(failure)).not.toThrow();
  expect(mockLogger.warn).not.toHaveBeenCalled();

  reportSubmissionException(submission);
  expect(mockLogger.warn).toHaveBeenCalledExactlyOnceWith({
    event: 'rendering.result.submission_persistence_exception',
    details: submission,
  });
});
