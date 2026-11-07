import { AppError } from '@/modules/kernel/domain/errors/app-error';

/** Server-only progress; a submission write failure cannot erase confirmed capture. */
export class SubmissionPersistenceError extends AppError {
  readonly receiptCaptured: boolean;
  readonly submissionWrite: 'not_attempted' | 'rejected' | 'unknown';
  constructor(
    cause: AppError,
    receiptCaptured: boolean,
    submissionWrite: SubmissionPersistenceError['submissionWrite'] = receiptCaptured
      ? 'unknown'
      : 'not_attempted'
  ) {
    super({
      code: cause.code,
      message: cause.message,
      details: cause.details,
      exposeDetails: cause.exposeDetails,
      category: cause.category,
      status: cause.status,
      retryable: cause.retryable,
      retryAfterMs: cause.retryAfterMs,
      cause,
    });
    this.receiptCaptured = receiptCaptured;
    this.submissionWrite = submissionWrite;
  }
}

/** Persistence-owned certainty; absence of reconciliation evidence is never rejection. */
export class SubmissionWriteError extends AppError {
  constructor(
    cause: AppError,
    readonly certainty: 'rejected' | 'unknown',
    retryable = cause.retryable
  ) {
    super({
      code: cause.code,
      message: cause.message,
      category: cause.category,
      status: cause.status,
      details: cause.details,
      exposeDetails: cause.exposeDetails,
      retryable,
      retryAfterMs: cause.retryAfterMs,
      cause,
    });
  }
}
