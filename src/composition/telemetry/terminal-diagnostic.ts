import type { LogFields } from '@/modules/kernel/application/ports/logger';
import { getLoggerConfig } from '@/modules/kernel/infrastructure/config/logger';
import {
  createTelemetryLogger,
  writeConsoleLogRecord,
} from '@/modules/kernel/infrastructure/logger/telemetry';
import { type TelemetryLogRecord, telemetryProxy } from '@/platform/telemetry';

const DELIVERY_TIMEOUT_MS = 5_000;

export async function reportTerminalDiagnostic(
  fields: Pick<LogFields, 'event' | 'details'>
) {
  let record: TelemetryLogRecord | undefined;
  try {
    createTelemetryLogger({
      telemetry: {
        ...telemetryProxy,
        emitLog: (entry) => {
          record = entry;
        },
      },
    }).error(fields);
    if (!record) return;

    const controller = new AbortController();
    const expired = new Promise<false>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(false), {
        once: true,
      });
    });
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const bootstrap = await Promise.race([
        import('./sentry.server'),
        expired,
      ]);
      if (bootstrap) {
        const { destinations } = bootstrap.initTelemetryServer();
        const entry = record;
        const outcomes = await Promise.all(
          destinations.map(async (deliver) =>
            Promise.race([deliver(entry, controller.signal), expired]).catch(
              () => false
            )
          )
        );
        if (outcomes.length > 0 && outcomes.every(Boolean)) return;
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  } catch {
    // Diagnostics never change persistence certainty or accounting dispatch.
  }
  try {
    if (record && !getLoggerConfig().consoleMirror)
      writeConsoleLogRecord(record);
  } catch {
    // A console failure is also best effort.
  }
}
