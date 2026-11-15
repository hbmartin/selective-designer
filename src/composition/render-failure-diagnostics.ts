import { createTelemetryLogger } from '@/modules/kernel/infrastructure/logger/telemetry';

import { createCachedFactory } from './shared/singleton';
import { telemetryProxy } from './telemetry';
import { getDiagnosticLoggerConfig } from './telemetry/diagnostic-logger-config';
import {
  type FailurePersistenceDetails,
  reportTerminalDiagnostic,
  type UnresolvedFailurePersistenceDetails,
} from './telemetry/terminal-diagnostic';

// Failure reporting must remain available when rendering or database setup fails.
const factory = createCachedFactory(() => {
  if (getDiagnosticLoggerConfig())
    return createTelemetryLogger({ telemetry: telemetryProxy });
});

function reportWarning(event: string, details: Record<string, unknown>) {
  try {
    factory.get()?.warn({ event, details });
  } catch {
    // An intermediate diagnostic cannot fail the recovery step.
  }
}

export const reportFailurePersistenceException = (
  details: FailurePersistenceDetails
) => reportWarning('rendering.result.failure_persistence_exception', details);

export const reportFailurePersistenceUnresolved = (
  details: UnresolvedFailurePersistenceDetails
) =>
  reportTerminalDiagnostic({
    event: 'rendering.result.failure_persistence_unresolved',
    details,
  });

export const reportSubmissionException = (details: {
  resultId: string;
  attempt: number;
  workflowRunId: string;
  code: string;
  lastKnownCode: string;
  errorNames: string[];
  errorCodes: string[];
}) =>
  reportWarning('rendering.result.submission_persistence_exception', details);

export const reportSubmissionUnresolved = (details: {
  resultId: string;
  attempt: number;
  workflowRunId: string;
  code: string;
  receiptCapture: 'confirmed' | 'unconfirmed';
}) =>
  reportTerminalDiagnostic({
    event: 'rendering.result.submission_unresolved',
    details,
  });
