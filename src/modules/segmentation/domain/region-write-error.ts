import { AppError } from '@/modules/kernel/domain/errors/app-error';

/** Persistence proof owned by the region port, independent of its database adapter. */
export class RegionWriteError extends AppError {
  constructor(
    readonly publication: 'rejected' | 'unknown',
    cause: unknown
  ) {
    super({
      code: 'REGION_WRITE_FAILED',
      category: 'system',
      status: 500,
      message: 'Region persistence failed',
      cause,
    });
  }
}
