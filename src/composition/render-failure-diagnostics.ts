import { createTelemetryLogger } from '@/modules/kernel/backend';

import { createCachedFactory } from './shared/singleton';
import { telemetryProxy } from './telemetry';
import {
  reportTerminalDiagnostic,
  type TerminalDiagnostic,
} from './telemetry/terminal-diagnostic';

// Failure reporting must remain available when rendering or database setup fails.
const factory = createCachedFactory(() =>
  createTelemetryLogger({ telemetry: telemetryProxy })
);
export const getRenderFailureLogger = () => factory.get();

export const reportFailurePersistenceUnresolved = (
  fields: Extract<
    TerminalDiagnostic,
    { event: 'rendering.result.failure_persistence_unresolved' }
  >
) => reportTerminalDiagnostic(fields);

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
