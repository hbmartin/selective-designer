import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TerminalDiagnostic } from '@/composition/telemetry/terminal-diagnostic';

vi.mock(
  '@/modules/kernel/infrastructure/logger/telemetry',
  async (original) => {
    const logger =
      await original<
        typeof import('@/modules/kernel/infrastructure/logger/telemetry')
      >();
    return {
      ...logger,
      createTelemetryLogger: vi.fn(logger.createTelemetryLogger),
    };
  }
);

const deliver = vi.hoisted(() => vi.fn());
vi.mock('@/composition/telemetry/sentry.server', () => ({
  getServerTelemetry: () => ({ destinations: [deliver] }),
}));

const fields = {
  event: 'image.write.unresolved',
  details: { imageId: 'image-1', errorNames: [], errorCodes: [] },
} satisfies TerminalDiagnostic;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('LOGGER_LEVEL', 'error');
  vi.stubEnv('LOGGER_CONSOLE_MIRROR', 'false');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  deliver.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('falls back with trace IDs when the logger does not produce a record', async () => {
  const { createTelemetryLogger } =
    await import('@/modules/kernel/infrastructure/logger/telemetry');
  vi.mocked(createTelemetryLogger).mockReturnValueOnce({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  const { createNoOpTelemetry, setTelemetry } =
    await import('@/platform/telemetry');
  const attributes = { traceId: 'trace-1', spanId: 'span-1' };
  setTelemetry({
    ...createNoOpTelemetry(),
    currentCorrelation: () => attributes,
  });
  const { reportTerminalDiagnostic } =
    await import('@/composition/telemetry/terminal-diagnostic');

  await reportTerminalDiagnostic(fields);

  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    fields.event,
    expect.objectContaining({
      level: 'error',
      details: fields.details,
      attributes,
    })
  );
  expect(deliver).not.toHaveBeenCalled();
});

it('uses only the fixed event and severity when details cannot be sanitized', async () => {
  const { reportTerminalDiagnostic } =
    await import('@/composition/telemetry/terminal-diagnostic');

  await reportTerminalDiagnostic({
    ...fields,
    details: {
      ...fields.details,
      get errorCodes(): string[] {
        throw new Error('private diagnostic input');
      },
    },
  });

  expect(console.error).toHaveBeenCalledExactlyOnceWith(fields.event, {
    level: 'error',
    event: fields.event,
  });
  expect(deliver).not.toHaveBeenCalled();
});

it('attempts a mirror only once even if the console throws and delivery fails', async () => {
  vi.stubEnv('LOGGER_CONSOLE_MIRROR', 'true');
  vi.mocked(console.error).mockImplementationOnce(() => {
    throw new Error('console failed after writing');
  });
  const { reportTerminalDiagnostic } =
    await import('@/composition/telemetry/terminal-diagnostic');

  await reportTerminalDiagnostic(fields);

  expect(deliver).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledOnce();
});
