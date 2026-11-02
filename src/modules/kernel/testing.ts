import type { ParseResult } from './domain/ids';

export type { ApplicationResult, DomainOutcome } from './application/result';
export { AppError } from './domain/errors/app-error';
export { IdValidationError } from './domain/errors/id-validation-error';
export type { ParseResult } from './domain/ids';
export * from './domain/ids';
export * as kernelDrizzleSchema from './infrastructure/db/schema';
export {
  type OutcomeHandlerConfig,
  unwrapApplicationResult,
} from './transport/tanstack/result-mapper';
export { ServerFnError } from './transport/tanstack/server-fn-error';

export function unwrapParseResult<TValue>(result: ParseResult<TValue>): TValue {
  if (result.isError()) throw result.getError();
  return result.get();
}
