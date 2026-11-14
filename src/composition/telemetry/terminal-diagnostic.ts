import { getLoggerConfig } from '@/modules/kernel/infrastructure/config/logger';
import {
  createTelemetryLogger,
  writeConsoleLogRecord,
} from '@/modules/kernel/infrastructure/logger/telemetry';
import { type TelemetryLogRecord, telemetryProxy } from '@/platform/telemetry';

import { retainRequestTask } from './request-lifetime';

const DELIVERY_TIMEOUT_MS = 5_000;

type ErrorDiagnostics = {
  code: string;
  errorNames: string[];
  errorCodes: string[];
};

type RenderExecution = {
  resultId: string;
  attempt: number;
  workflowRunId: string;
  receiptCapture: 'confirmed' | 'unconfirmed';
};

export type FailurePersistenceDetails = RenderExecution &
  ErrorDiagnostics & { reason: string };

export type UnresolvedFailurePersistenceDetails = FailurePersistenceDetails & {
  recoveryWaitError?: ErrorDiagnostics;
};

export type TerminalDiagnostic =
  | {
      event: 'rendering.result.failure_persistence_unresolved';
      details: UnresolvedFailurePersistenceDetails;
    }
  | {
      event: 'rendering.result.submission_unresolved';
      details: RenderExecution & { code: string };
    }
  | {
      event: 'image.write.unresolved';
      details: { imageId: string; errorNames: string[]; errorCodes: string[] };
    };

type PreparedDiagnostic = {
  record: TelemetryLogRecord;
  consoleMirror: boolean;
};

function prepareDiagnostic(
  fields: TerminalDiagnostic
): PreparedDiagnostic | undefined {
  let consoleMirror: boolean;
  try {
    ({ consoleMirror } = getLoggerConfig());
  } catch {
    // The workflow host can report failures before SSR validates configuration.
    writeFallback({
      record: { event: fields.event, level: 'error', details: fields.details },
      consoleMirror: false,
    });
    return;
  }

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
    if (record) return { record, consoleMirror };
  } catch {
    // Diagnostics never change the operation's outcome.
  }
}

function writeFallback({ record, consoleMirror }: PreparedDiagnostic) {
  try {
    if (!consoleMirror) writeConsoleLogRecord(record);
  } catch {
    // A console failure is also best effort.
  }
}

async function deliverDiagnostic(prepared: PreparedDiagnostic) {
  try {
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
        const { destinations } = bootstrap.getServerTelemetry();
        const outcomes = await Promise.all(
          destinations.map(async (deliver) =>
            Promise.race([
              deliver(prepared.record, controller.signal),
              expired,
            ]).catch(() => false)
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
  writeFallback(prepared);
}

export async function reportTerminalDiagnostic(fields: TerminalDiagnostic) {
  const prepared = prepareDiagnostic(fields);
  if (prepared) await deliverDiagnostic(prepared);
}

export function deferTerminalDiagnostic(fields: TerminalDiagnostic) {
  const prepared = prepareDiagnostic(fields);
  if (prepared && !retainRequestTask(() => deliverDiagnostic(prepared)))
    writeFallback(prepared);
}
