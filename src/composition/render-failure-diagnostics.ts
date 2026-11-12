import { createTelemetryLogger } from '@/modules/kernel/backend';

import { createCachedFactory } from './shared/singleton';
import { telemetryProxy } from './telemetry';
import {
  reportTerminalDiagnostic,
  type TerminalDiagnostic,
} from './telemetry/terminal-diagnostic';

type FailurePersistenceDetails = Extract<
  TerminalDiagnostic,
  { event: 'rendering.result.failure_persistence_unresolved' }
>['details'];

// Failure reporting must remain available when rendering or database setup fails.
const factory = createCachedFactory(() =>
  createTelemetryLogger({ telemetry: telemetryProxy })
);

export const reportFailurePersistenceException = (
  details: FailurePersistenceDetails
) =>
  factory.get().warn({
    event: 'rendering.result.failure_persistence_exception',
    details,
  });

export const reportFailurePersistenceUnresolved = (
  details: FailurePersistenceDetails
) =>
  reportTerminalDiagnostic({
    event: 'rendering.result.failure_persistence_unresolved',
    details,
  });

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
