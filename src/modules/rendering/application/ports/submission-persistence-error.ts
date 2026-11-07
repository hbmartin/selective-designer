import { AppError } from '@/modules/kernel/domain/errors/app-error';

/** Server-only progress; a submission write failure cannot erase confirmed capture. */
export class SubmissionPersistenceError extends AppError {
  readonly receiptCaptured: boolean;
  constructor(cause: AppError, receiptCaptured: boolean) {
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
  }
}
