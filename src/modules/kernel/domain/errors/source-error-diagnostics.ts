import { ObjectCopySourceError } from './object-copy-source-error';
import { safeErrorDiagnostics } from './safe-error-diagnostics';

export const sourceErrorDiagnostics = (error: unknown) => ({
  ...safeErrorDiagnostics(error),
  ...(error instanceof ObjectCopySourceError
    ? {
        reason: error.reason,
        attempts: error.attempts,
        sourceStatus: error.sourceStatus,
      }
    : {}),
});
