import { AppError } from './app-error';

/** A source read failed. No destination write has been attempted. */
export class ObjectCopySourceError extends AppError {
  readonly reason: 'network' | 'timeout' | 'http';
  readonly attempts: number;
  readonly sourceStatus?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: {
    reason: 'network' | 'timeout' | 'http';
    attempts: number;
    status?: number;
    cause: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  }) {
    super({
      code: 'OBJECT_COPY_SOURCE_FAILED',
      category: input.status === 429 ? 'rate_limit' : 'system',
      status: 502,
      message: 'The image source could not be downloaded. Try again.',
      cause: input.cause,
    });
    this.reason = input.reason;
    this.attempts = input.attempts;
    this.sourceStatus = input.status;
    this.retryable = input.retryable ?? true;
    this.retryAfterMs = input.retryAfterMs;
  }
}
