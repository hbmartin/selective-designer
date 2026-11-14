import { getLoggerConfigResult } from '@/modules/kernel/infrastructure/config/logger';
import { writeConsoleLogRecord } from '@/modules/kernel/infrastructure/logger/telemetry';

const noticeKey = Symbol.for('selective-designer.logger-config-invalid');
const loggerFields = ['LOGGER_LEVEL', 'LOGGER_CONSOLE_MIRROR', 'LOGGER_PRETTY'];

export function getDiagnosticLoggerConfig() {
  const { config, error } = getLoggerConfigResult();
  if (config) return config;

  const host = globalThis as typeof globalThis & { [noticeKey]?: true };
  if (host[noticeKey]) return;
  host[noticeKey] = true;
  try {
    const issues = error.details?.issues;
    const fields = loggerFields.filter(
      (field) =>
        Array.isArray(issues) &&
        issues.some((issue: { field?: unknown }) => issue.field === field)
    );
    writeConsoleLogRecord({
      event: 'telemetry.logger_config_invalid',
      level: 'error',
      details: { code: error.code, fields },
    });
  } catch {
    // A console failure must not interrupt recovery or terminal reporting.
  }
}
