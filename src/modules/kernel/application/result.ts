import type { Result } from '@bloodyowl/boxed';

import type { AppError } from '../domain/errors/app-error';

export type ApplicationResult<TOutcome> = Result<TOutcome, AppError>;

export type DomainOutcome = {
  type: string;
};
